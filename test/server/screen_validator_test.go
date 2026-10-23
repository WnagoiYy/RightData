package server_test

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"server/app"
)

func TestValidateScreenBundleAcceptsCanonicalBundle(t *testing.T) {
	raw, expected := screenValidBundle(t, "validator-screen", "1.2.3", []byte("<!doctype html><title>safe</title>"))
	path := screenWriteZIP(t, raw)
	actual, err := app.ValidateScreenBundle(screenTestContext(t), path, "validator-screen")
	if err != nil {
		t.Fatal(err)
	}
	if actual.ScreenID != expected.ScreenID || actual.Version != expected.Version || actual.Entry != expected.Entry || actual.ContainerAPIVersion != expected.ContainerAPIVersion {
		t.Fatalf("validated manifest changed identity: got %#v want %#v", actual, expected)
	}
	if len(actual.Files) != len(expected.Files) {
		t.Fatalf("validated manifest changed file list: got %#v want %#v", actual.Files, expected.Files)
	}
}

func TestValidateScreenBundleRejectsDangerousZIPs(t *testing.T) {
	valid, _ := screenValidBundle(t, "validator-screen", "1.2.3", []byte("<html>valid</html>"))
	tests := []struct {
		name  string
		build func(*testing.T) []byte
	}{
		{"parent traversal", func(t *testing.T) []byte { return screenSinglePathBundle(t, "../index.html", "../index.html") }},
		{"backslash", func(t *testing.T) []byte { return screenSinglePathBundle(t, `assets\index.html`, `assets\index.html`) }},
		{"absolute slash", func(t *testing.T) []byte { return screenSinglePathBundle(t, "/index.html", "/index.html") }},
		{"absolute drive", func(t *testing.T) []byte { return screenSinglePathBundle(t, "C:/index.html", "C:/index.html") }},
		{"empty segment", func(t *testing.T) []byte {
			return screenSinglePathBundle(t, "assets//index.html", "assets//index.html")
		}},
		{"dot segment", func(t *testing.T) []byte {
			return screenSinglePathBundle(t, "assets/./index.html", "assets/./index.html")
		}},
		{"windows reserved name", func(t *testing.T) []byte { return screenSinglePathBundle(t, "assets/CON.js", "assets/CON.js") }},
		{"trailing dot", func(t *testing.T) []byte {
			return screenSinglePathBundle(t, "assets./index.html", "assets./index.html")
		}},
		{"path over 240 bytes", func(t *testing.T) []byte {
			path := strings.Repeat("a", 231) + "/index.html"
			return screenSinglePathBundle(t, path, path)
		}},
		{"path over 16 levels", func(t *testing.T) []byte {
			path := strings.Repeat("a/", 17) + "index.html"
			return screenSinglePathBundle(t, path, path)
		}},
		{"manifest path over 16 levels", screenDeepManifestPathBundle},
		{"case-insensitive duplicate", screenCaseDuplicateBundle},
		{"symbolic link", screenSymlinkBundle},
		{"file directory conflict", screenFileDirectoryConflictBundle},
		{"entry is not html", func(t *testing.T) []byte { return screenSinglePathBundle(t, "app.js", "app.js") }},
		{"entry absent from manifest", screenEntryAbsentBundle},
		{"manifest file missing from zip", screenMissingFileBundle},
		{"zip file missing from manifest", screenExtraFileBundle},
		{"file size mismatch", screenSizeMismatchBundle},
		{"file digest mismatch", screenHashMismatchBundle},
		{"uppercase digest", screenUppercaseHashBundle},
		{"duplicate root manifest", screenDuplicateManifestBundle},
		{"manifest below zip root", screenNestedManifestBundle},
		{"missing manifest", screenMissingManifestBundle},
		{"malformed manifest", screenMalformedManifestBundle},
		{"manifest duplicate key", screenDuplicateManifestKeyBundle},
		{"manifest unknown field", screenUnknownManifestFieldBundle},
		{"manifest files is null", screenNullManifestFilesBundle},
		{"manifest JSON nesting over limit", screenDeepManifestJSONBundle},
		{"wrong screen id", screenWrongIDBundle},
		{"unstable semantic version", screenPrereleaseVersionBundle},
		{"short semantic version", screenShortVersionBundle},
		{"leading-zero semantic version", screenLeadingZeroVersionBundle},
		{"unsupported container api", screenUnsupportedContainerBundle},
		{"string container api", screenStringContainerBundle},
		{"too many manifest files", screenTooManyFilesBundle},
		{"too many zip entries", screenTooManyZIPEntriesBundle},
		{"manifest over one MiB", screenOversizedManifestBundle},
		{"single file over 32 MiB", screenOversizedFileBundle},
		{"total expanded content over 200 MiB", screenOversizedExpandedBundle},
		{"compression ratio over 100", screenCompressionRatioBundle},
		{"unsupported compression method", func(t *testing.T) []byte {
			patched := screenPatchAll16(valid, []byte("PK\x03\x04"), 8, 99)
			return screenPatchAll16(patched, []byte("PK\x01\x02"), 10, 99)
		}},
		{"local header dangerous name", func(t *testing.T) []byte {
			return screenPatchLocalHeader(t, valid, "index.html", func(header []byte) {
				copy(header[30:40], "../bad.htm")
			})
		}},
		{"local header encryption flag only", func(t *testing.T) []byte {
			return screenPatchLocalHeader(t, valid, "index.html", func(header []byte) {
				flags := binary.LittleEndian.Uint16(header[6:8])
				binary.LittleEndian.PutUint16(header[6:8], flags|1)
			})
		}},
		{"local and central methods disagree", func(t *testing.T) []byte {
			return screenPatchLocalHeader(t, valid, "index.html", func(header []byte) {
				binary.LittleEndian.PutUint16(header[8:10], zip.Store)
			})
		}},
		{"encrypted entry flag", func(t *testing.T) []byte {
			patched := screenPatchAll16(valid, []byte("PK\x03\x04"), 6, 1)
			return screenPatchAll16(patched, []byte("PK\x01\x02"), 8, 1)
		}},
		{"self extracting prefix", func(t *testing.T) []byte { return append([]byte("MZ-screen-prefix"), valid...) }},
		{"multi volume metadata", func(t *testing.T) []byte { return screenPatchEOCDMultiVolume(t, valid) }},
		{"central directory has more entries than EOCD declares", func(t *testing.T) []byte {
			return screenPatchEOCDEntryCount(t, valid, 1)
		}},
		{"zip64 metadata", func(t *testing.T) []byte { return screenPatchEOCDZIP64(t, valid) }},
		{"truncated archive", func(t *testing.T) []byte { return append([]byte(nil), valid[:len(valid)-12]...) }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			path := screenWriteZIP(t, test.build(t))
			_, err := app.ValidateScreenBundle(screenTestContext(t), path, "validator-screen")
			screenRequireError(t, err)
		})
	}

	t.Run("archive over 50 MiB", func(t *testing.T) {
		dir := screenRuntimeTempDir(t)
		path := filepath.Join(dir, "oversized.zip")
		file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
		if err != nil {
			t.Fatal(err)
		}
		if err = file.Truncate(app.ScreenMaxArchiveBytes + 1); err != nil {
			_ = file.Close()
			t.Fatal(err)
		}
		if err = file.Close(); err != nil {
			t.Fatal(err)
		}
		_, err = app.ValidateScreenBundle(screenTestContext(t), path, "validator-screen")
		screenRequireError(t, err)
	})
}

func screenSinglePathBundle(t *testing.T, path, entry string) []byte {
	t.Helper()
	data := []byte("<html>path</html>")
	manifest := screenManifest("validator-screen", "1.2.3", entry, map[string][]byte{path: data})
	return screenBuildZIP(t, manifest, []screenZipEntry{{Name: path, Data: data}})
}

func screenDeepManifestPathBundle(t *testing.T) []byte {
	t.Helper()
	data := []byte("<html>index</html>")
	deepPath := strings.Repeat("a/", 17) + "index.html"
	manifest := screenManifest("validator-screen", "1.2.3", "index.html", map[string][]byte{deepPath: data})
	return screenBuildZIP(t, manifest, []screenZipEntry{{Name: "index.html", Data: data}})
}

func screenCaseDuplicateBundle(t *testing.T) []byte {
	t.Helper()
	upper := []byte("<html>upper</html>")
	lower := []byte("<html>lower</html>")
	manifest := app.ScreenManifest{
		ScreenID: "validator-screen", Version: "1.2.3", Entry: "Index.html", ContainerAPIVersion: 1,
		Files: []app.ScreenManifestFile{
			{Path: "Index.html", Size: int64(len(upper)), SHA256: screenSHA256(upper)},
			{Path: "index.HTML", Size: int64(len(lower)), SHA256: screenSHA256(lower)},
		},
	}
	return screenBuildZIP(t, manifest, []screenZipEntry{{Name: "Index.html", Data: upper}, {Name: "index.HTML", Data: lower}})
}

func screenSymlinkBundle(t *testing.T) []byte {
	t.Helper()
	target := []byte("index.html")
	manifest := app.ScreenManifest{
		ScreenID: "validator-screen", Version: "1.2.3", Entry: "link.html", ContainerAPIVersion: 1,
		Files: []app.ScreenManifestFile{{Path: "link.html", Size: int64(len(target)), SHA256: screenSHA256(target)}},
	}
	return screenBuildZIP(t, manifest, []screenZipEntry{{Name: "link.html", Data: target, Mode: os.ModeSymlink | 0o777}})
}

func screenFileDirectoryConflictBundle(t *testing.T) []byte {
	t.Helper()
	root := []byte("plain file")
	child := []byte("<html>child</html>")
	manifest := app.ScreenManifest{
		ScreenID: "validator-screen", Version: "1.2.3", Entry: "assets/index.html", ContainerAPIVersion: 1,
		Files: []app.ScreenManifestFile{
			{Path: "assets", Size: int64(len(root)), SHA256: screenSHA256(root)},
			{Path: "assets/index.html", Size: int64(len(child)), SHA256: screenSHA256(child)},
		},
	}
	return screenBuildZIP(t, manifest, []screenZipEntry{{Name: "assets", Data: root}, {Name: "assets/index.html", Data: child}})
}

func screenEntryAbsentBundle(t *testing.T) []byte {
	t.Helper()
	data := []byte("<html>only index</html>")
	manifest := screenManifest("validator-screen", "1.2.3", "other.html", map[string][]byte{"index.html": data})
	return screenBuildZIP(t, manifest, []screenZipEntry{{Name: "index.html", Data: data}})
}

func screenMissingFileBundle(t *testing.T) []byte {
	t.Helper()
	index := []byte("<html>index</html>")
	missing := []byte("missing")
	manifest := screenManifest("validator-screen", "1.2.3", "index.html", map[string][]byte{"index.html": index, "missing.js": missing})
	return screenBuildZIP(t, manifest, []screenZipEntry{{Name: "index.html", Data: index}})
}

func screenExtraFileBundle(t *testing.T) []byte {
	t.Helper()
	index := []byte("<html>index</html>")
	manifest := screenManifest("validator-screen", "1.2.3", "index.html", map[string][]byte{"index.html": index})
	return screenBuildZIP(t, manifest, []screenZipEntry{{Name: "index.html", Data: index}, {Name: "extra.js", Data: []byte("extra")}})
}

func screenSizeMismatchBundle(t *testing.T) []byte {
	t.Helper()
	data := []byte("<html>index</html>")
	manifest := screenManifest("validator-screen", "1.2.3", "index.html", map[string][]byte{"index.html": data})
	manifest.Files[0].Size++
	return screenBuildZIP(t, manifest, []screenZipEntry{{Name: "index.html", Data: data}})
}

func screenHashMismatchBundle(t *testing.T) []byte {
	t.Helper()
	data := []byte("<html>index</html>")
	manifest := screenManifest("validator-screen", "1.2.3", "index.html", map[string][]byte{"index.html": data})
	manifest.Files[0].SHA256 = strings.Repeat("0", 64)
	return screenBuildZIP(t, manifest, []screenZipEntry{{Name: "index.html", Data: data}})
}

func screenUppercaseHashBundle(t *testing.T) []byte {
	t.Helper()
	data := []byte("<html>index</html>")
	manifest := screenManifest("validator-screen", "1.2.3", "index.html", map[string][]byte{"index.html": data})
	manifest.Files[0].SHA256 = strings.ToUpper(manifest.Files[0].SHA256)
	return screenBuildZIP(t, manifest, []screenZipEntry{{Name: "index.html", Data: data}})
}

func screenDuplicateManifestBundle(t *testing.T) []byte {
	t.Helper()
	data := []byte("<html>index</html>")
	manifest := screenManifest("validator-screen", "1.2.3", "index.html", map[string][]byte{"index.html": data})
	encoded, _ := json.Marshal(manifest)
	return screenBuildZIP(t, manifest, []screenZipEntry{{Name: "manifest.json", Data: encoded, Method: zip.Store}, {Name: "index.html", Data: data}})
}

func screenNestedManifestBundle(t *testing.T) []byte {
	t.Helper()
	data := []byte("<html>index</html>")
	manifest := screenManifest("validator-screen", "1.2.3", "index.html", map[string][]byte{"index.html": data})
	encoded, _ := json.Marshal(manifest)
	return screenBuildZIP(t, nil, []screenZipEntry{{Name: "nested/manifest.json", Data: encoded}, {Name: "index.html", Data: data}})
}

func screenMissingManifestBundle(t *testing.T) []byte {
	t.Helper()
	return screenBuildZIP(t, nil, []screenZipEntry{{Name: "index.html", Data: []byte("<html>index</html>")}})
}

func screenMalformedManifestBundle(t *testing.T) []byte {
	t.Helper()
	return screenBuildZIP(t, nil, []screenZipEntry{{Name: "manifest.json", Data: []byte(`{"screenId":`)}, {Name: "index.html", Data: []byte("<html>index</html>")}})
}

func screenDuplicateManifestKeyBundle(t *testing.T) []byte {
	t.Helper()
	raw := `{"screenId":"validator-screen","screenId":"validator-screen","version":"1.2.3","entry":"index.html","containerApiVersion":1,"files":[]}`
	return screenBuildZIP(t, nil, []screenZipEntry{{Name: "manifest.json", Data: []byte(raw)}})
}

func screenUnknownManifestFieldBundle(t *testing.T) []byte {
	t.Helper()
	raw := `{"screenId":"validator-screen","version":"1.2.3","entry":"index.html","containerApiVersion":1,"files":[],"unexpected":true}`
	return screenBuildZIP(t, nil, []screenZipEntry{{Name: "manifest.json", Data: []byte(raw)}})
}

func screenNullManifestFilesBundle(t *testing.T) []byte {
	t.Helper()
	raw := `{"screenId":"validator-screen","version":"1.2.3","entry":"index.html","containerApiVersion":1,"files":null}`
	return screenBuildZIP(t, nil, []screenZipEntry{{Name: "manifest.json", Data: []byte(raw)}})
}

func screenDeepManifestJSONBundle(t *testing.T) []byte {
	t.Helper()
	deep := strings.Repeat("[", 20) + "0" + strings.Repeat("]", 20)
	raw := fmt.Sprintf(`{"screenId":"validator-screen","version":"1.2.3","entry":"index.html","containerApiVersion":1,"files":[],"deep":%s}`, deep)
	return screenBuildZIP(t, nil, []screenZipEntry{{Name: "manifest.json", Data: []byte(raw)}})
}

func screenWrongIDBundle(t *testing.T) []byte {
	t.Helper()
	raw, _ := screenValidBundle(t, "other-screen", "1.2.3", []byte("<html>index</html>"))
	return raw
}

func screenPrereleaseVersionBundle(t *testing.T) []byte {
	t.Helper()
	raw, _ := screenValidBundle(t, "validator-screen", "1.2.3-beta.1", []byte("<html>index</html>"))
	return raw
}

func screenShortVersionBundle(t *testing.T) []byte {
	t.Helper()
	raw, _ := screenValidBundle(t, "validator-screen", "1.2", []byte("<html>index</html>"))
	return raw
}

func screenLeadingZeroVersionBundle(t *testing.T) []byte {
	t.Helper()
	raw, _ := screenValidBundle(t, "validator-screen", "01.2.3", []byte("<html>index</html>"))
	return raw
}

func screenUnsupportedContainerBundle(t *testing.T) []byte {
	t.Helper()
	data := []byte("<html>index</html>")
	manifest := screenManifest("validator-screen", "1.2.3", "index.html", map[string][]byte{"index.html": data})
	manifest.ContainerAPIVersion = 2
	return screenBuildZIP(t, manifest, []screenZipEntry{{Name: "index.html", Data: data}})
}

func screenStringContainerBundle(t *testing.T) []byte {
	t.Helper()
	data := []byte("<html>index</html>")
	manifest := fmt.Sprintf(`{"screenId":"validator-screen","version":"1.2.3","entry":"index.html","containerApiVersion":"1","files":[{"path":"index.html","size":%d,"sha256":"%s"}]}`, len(data), screenSHA256(data))
	return screenBuildZIP(t, nil, []screenZipEntry{{Name: "manifest.json", Data: []byte(manifest), Method: zip.Store}, {Name: "index.html", Data: data}})
}

func screenTooManyFilesBundle(t *testing.T) []byte {
	t.Helper()
	files := make([]app.ScreenManifestFile, 0, app.ScreenMaxFiles+1)
	files = append(files, app.ScreenManifestFile{Path: "index.html", Size: 0, SHA256: screenSHA256(nil)})
	for index := 1; index <= app.ScreenMaxFiles; index++ {
		files = append(files, app.ScreenManifestFile{Path: fmt.Sprintf("f/%04d.js", index), Size: 0, SHA256: screenSHA256(nil)})
	}
	manifest := app.ScreenManifest{ScreenID: "validator-screen", Version: "1.2.3", Entry: "index.html", ContainerAPIVersion: 1, Files: files}
	entries := make([]screenZipEntry, 0, len(files))
	for _, file := range files {
		entries = append(entries, screenZipEntry{Name: file.Path, Data: nil})
	}
	return screenBuildZIP(t, manifest, entries)
}

func screenTooManyZIPEntriesBundle(t *testing.T) []byte {
	t.Helper()
	index := []byte("<html>index</html>")
	manifest := screenManifest("validator-screen", "1.2.3", "index.html", map[string][]byte{"index.html": index})
	entries := make([]screenZipEntry, 0, 4098)
	for number := 0; number <= 4096; number++ {
		entries = append(entries, screenZipEntry{Name: fmt.Sprintf("d%04d/", number), Method: zip.Store, Mode: os.ModeDir | 0o755})
	}
	entries = append(entries, screenZipEntry{Name: "index.html", Data: index})
	return screenBuildZIP(t, manifest, entries)
}

func screenOversizedManifestBundle(t *testing.T) []byte {
	t.Helper()
	padding := strings.Repeat("x", int(app.ScreenMaxManifestBytes))
	manifest := fmt.Sprintf(`{"screenId":"validator-screen","version":"1.2.3","entry":"index.html","containerApiVersion":1,"files":[],"padding":"%s"}`, padding)
	return screenBuildZIP(t, nil, []screenZipEntry{{Name: "manifest.json", Data: []byte(manifest), Method: zip.Store}})
}

func screenOversizedFileBundle(t *testing.T) []byte {
	t.Helper()
	size := app.ScreenMaxFileBytes + 1
	data := bytes.Repeat([]byte{'x'}, int(size))
	manifest := screenManifest("validator-screen", "1.2.3", "index.html", map[string][]byte{"index.html": data})
	return screenBuildZIP(t, manifest, []screenZipEntry{{Name: "index.html", Data: data}})
}

func screenCompressionRatioBundle(t *testing.T) []byte {
	t.Helper()
	data := bytes.Repeat([]byte{0}, 1<<20)
	manifest := screenManifest("validator-screen", "1.2.3", "index.html", map[string][]byte{"index.html": data})
	return screenBuildZIP(t, manifest, []screenZipEntry{{Name: "index.html", Data: data, Method: zip.Deflate}})
}

func screenOversizedExpandedBundle(t *testing.T) []byte {
	t.Helper()
	const perFile = uint32(32 << 20)
	manifest := app.ScreenManifest{ScreenID: "validator-screen", Version: "1.2.3", Entry: "f0.html", ContainerAPIVersion: 1}
	entries := make([]screenZipEntry, 0, 7)
	for index := 0; index < 7; index++ {
		name := fmt.Sprintf("f%d.html", index)
		manifest.Files = append(manifest.Files, app.ScreenManifestFile{Path: name, Size: int64(perFile), SHA256: screenSHA256(nil)})
		entries = append(entries, screenZipEntry{Name: name, Data: nil})
	}
	raw := screenBuildZIP(t, manifest, entries)
	patched := append([]byte(nil), raw...)
	for start := 0; ; {
		index := bytes.Index(patched[start:], []byte("PK\x01\x02"))
		if index < 0 {
			break
		}
		index += start
		if index+28 > len(patched) {
			t.Fatal("short central directory entry")
		}
		nameLength := int(binary.LittleEndian.Uint16(patched[index+28 : index+30]))
		if index+46+nameLength > len(patched) {
			t.Fatal("short central directory filename")
		}
		name := string(patched[index+46 : index+46+nameLength])
		if name != "manifest.json" {
			binary.LittleEndian.PutUint32(patched[index+24:index+28], perFile)
		}
		start = index + 4
	}
	return patched
}

func screenPatchEOCDMultiVolume(t *testing.T, raw []byte) []byte {
	t.Helper()
	patched := append([]byte(nil), raw...)
	index := bytes.LastIndex(patched, []byte("PK\x05\x06"))
	if index < 0 || index+22 > len(patched) {
		t.Fatal("test ZIP has no EOCD")
	}
	binary.LittleEndian.PutUint16(patched[index+4:index+6], 1)
	binary.LittleEndian.PutUint16(patched[index+6:index+8], 1)
	return patched
}

func screenPatchLocalHeader(t *testing.T, raw []byte, target string, mutate func([]byte)) []byte {
	t.Helper()
	patched := append([]byte(nil), raw...)
	for start := 0; ; {
		index := bytes.Index(patched[start:], []byte("PK\x03\x04"))
		if index < 0 {
			break
		}
		index += start
		if index+30 > len(patched) {
			t.Fatal("short local ZIP header")
		}
		nameLength := int(binary.LittleEndian.Uint16(patched[index+26 : index+28]))
		extraLength := int(binary.LittleEndian.Uint16(patched[index+28 : index+30]))
		headerEnd := index + 30 + nameLength + extraLength
		if headerEnd > len(patched) {
			t.Fatal("short local ZIP filename or extra field")
		}
		if string(patched[index+30:index+30+nameLength]) == target {
			mutate(patched[index:headerEnd])
			return patched
		}
		start = index + 4
	}
	t.Fatalf("local ZIP header for %q was not found", target)
	return nil
}

func screenPatchEOCDEntryCount(t *testing.T, raw []byte, count uint16) []byte {
	t.Helper()
	patched := append([]byte(nil), raw...)
	index := bytes.LastIndex(patched, []byte("PK\x05\x06"))
	if index < 0 || index+22 > len(patched) {
		t.Fatal("test ZIP has no EOCD")
	}
	binary.LittleEndian.PutUint16(patched[index+8:index+10], count)
	binary.LittleEndian.PutUint16(patched[index+10:index+12], count)
	return patched
}

func screenPatchEOCDZIP64(t *testing.T, raw []byte) []byte {
	t.Helper()
	patched := append([]byte(nil), raw...)
	index := bytes.LastIndex(patched, []byte("PK\x05\x06"))
	if index < 0 || index+22 > len(patched) {
		t.Fatal("test ZIP has no EOCD")
	}
	binary.LittleEndian.PutUint16(patched[index+8:index+10], 0xffff)
	binary.LittleEndian.PutUint16(patched[index+10:index+12], 0xffff)
	binary.LittleEndian.PutUint32(patched[index+12:index+16], 0xffffffff)
	binary.LittleEndian.PutUint32(patched[index+16:index+20], 0xffffffff)
	return patched
}
