package app

import (
	"archive/zip"
	"bytes"
	"compress/flate"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"hash/crc32"
	"io"
	"os"
	"path"
	"regexp"
	"sort"
	"strings"
	"unicode/utf8"
)

const screenMaxZIPEntries = 4096

var screenSHA256Pattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

type screenZIPEntry struct {
	file      *zip.File
	path      string
	directory bool
}

type screenPathNode struct {
	directory bool
	spelling  string
}

type screenEntryDigest struct {
	size   int64
	sha256 string
}

func invalidScreenBundle(message string) error {
	return Error(400, "invalid_screen_bundle", message)
}

func screenBundleTooLarge(message string) error {
	return Error(413, "screen_bundle_too_large", message)
}

// ValidateScreenBundle validates an immutable screen ZIP without extracting or executing it.
func ValidateScreenBundle(ctx context.Context, filePath, screenID string) (ScreenManifest, error) {
	if err := ctx.Err(); err != nil {
		return ScreenManifest{}, err
	}
	pathInfo, err := os.Lstat(filePath)
	if err != nil {
		return ScreenManifest{}, err
	}
	if !pathInfo.Mode().IsRegular() || pathInfo.Mode()&os.ModeSymlink != 0 {
		return ScreenManifest{}, invalidScreenBundle("大屏资源包必须是普通 ZIP 文件")
	}
	archive, err := os.Open(filePath)
	if err != nil {
		return ScreenManifest{}, err
	}
	defer archive.Close()
	info, err := archive.Stat()
	if err != nil {
		return ScreenManifest{}, err
	}
	if !info.Mode().IsRegular() || !os.SameFile(pathInfo, info) {
		return ScreenManifest{}, invalidScreenBundle("大屏资源包在验证期间发生变化")
	}
	archiveSize := info.Size()
	if archiveSize <= 0 {
		return ScreenManifest{}, invalidScreenBundle("大屏资源包为空")
	}
	if archiveSize > ScreenMaxArchiveBytes {
		return ScreenManifest{}, screenBundleTooLarge("大屏资源包超过大小限制")
	}
	declaredEntries, err := screenPreflightZIP(archive, archiveSize)
	if err != nil {
		return ScreenManifest{}, err
	}
	reader, err := zip.NewReader(archive, archiveSize)
	if err != nil {
		return ScreenManifest{}, invalidScreenBundle("大屏资源包不是有效 ZIP")
	}
	if len(reader.File) != declaredEntries || len(reader.File) > screenMaxZIPEntries {
		return ScreenManifest{}, invalidScreenBundle("ZIP 条目数量与中央目录不一致")
	}

	entries := make([]screenZIPEntry, 0, len(reader.File))
	regularFiles := make(map[string]*zip.File, len(reader.File))
	entryNames := make(map[string]struct{}, len(reader.File))
	nodes := make(map[string]screenPathNode, len(reader.File)*2)
	var manifestFile *zip.File
	var expandedBytes int64
	payloadFileCount := 0

	for _, item := range reader.File {
		if err = ctx.Err(); err != nil {
			return ScreenManifest{}, err
		}
		if item.Flags&((1<<0)|(1<<6)|(1<<13)) != 0 {
			return ScreenManifest{}, invalidScreenBundle("大屏资源包不能加密")
		}
		if item.Method != zip.Store && item.Method != zip.Deflate {
			return ScreenManifest{}, invalidScreenBundle("大屏资源包只支持 Store 或 Deflate 压缩")
		}
		if err = screenValidateZIPExtra(item.Extra); err != nil {
			return ScreenManifest{}, err
		}
		mode := item.Mode()
		if mode&os.ModeSymlink != 0 || mode&os.ModeType != 0 && !mode.IsDir() {
			return ScreenManifest{}, invalidScreenBundle("大屏资源包包含符号链接或特殊文件")
		}
		directory := item.FileInfo().IsDir()
		if directory != strings.HasSuffix(item.Name, "/") {
			return ScreenManifest{}, invalidScreenBundle("ZIP 目录条目格式无效")
		}
		parts, normalizedPath, pathErr := validateScreenBundlePath(item.Name, directory)
		if pathErr != nil {
			return ScreenManifest{}, pathErr
		}
		if err = registerScreenBundlePath(parts, normalizedPath, directory, entryNames, nodes); err != nil {
			return ScreenManifest{}, err
		}
		if directory {
			if item.UncompressedSize64 != 0 {
				return ScreenManifest{}, invalidScreenBundle("ZIP 目录条目必须为空")
			}
		} else {
			if item.UncompressedSize64 > uint64(ScreenMaxFileBytes) {
				return ScreenManifest{}, screenBundleTooLarge("大屏资源包中的单个文件超过大小限制")
			}
			if item.Name == "manifest.json" {
				if manifestFile != nil {
					return ScreenManifest{}, invalidScreenBundle("ZIP 根只能包含一个 manifest.json")
				}
				if item.UncompressedSize64 > uint64(ScreenMaxManifestBytes) {
					return ScreenManifest{}, screenBundleTooLarge("manifest.json 超过大小限制")
				}
				manifestFile = item
			} else {
				payloadFileCount++
				if payloadFileCount > ScreenMaxFiles {
					return ScreenManifest{}, screenBundleTooLarge("大屏资源包文件数量超过限制")
				}
			}
			regularFiles[item.Name] = item
		}
		if screenCompressionRatioExceeded(item.UncompressedSize64, item.CompressedSize64) {
			return ScreenManifest{}, screenBundleTooLarge("大屏资源包中的文件压缩比超过限制")
		}
		if item.UncompressedSize64 > uint64(ScreenMaxExpandedBytes-expandedBytes) {
			return ScreenManifest{}, screenBundleTooLarge("大屏资源包展开内容超过大小限制")
		}
		expandedBytes += int64(item.UncompressedSize64)
		entries = append(entries, screenZIPEntry{file: item, path: normalizedPath, directory: directory})
	}
	if manifestFile == nil {
		return ScreenManifest{}, invalidScreenBundle("ZIP 根缺少 manifest.json")
	}
	if expandedBytes > archiveSize*ScreenMaxCompressionRatio {
		return ScreenManifest{}, screenBundleTooLarge("大屏资源包整体压缩比超过限制")
	}

	digests := make(map[string]screenEntryDigest, len(regularFiles))
	var manifestJSON []byte
	for _, entry := range entries {
		if err = ctx.Err(); err != nil {
			return ScreenManifest{}, err
		}
		capture := entry.file == manifestFile
		limit := ScreenMaxFileBytes
		if capture {
			limit = ScreenMaxManifestBytes
		}
		data, digest, readErr := readScreenZIPEntry(ctx, entry.file, limit, capture, entry.directory)
		if readErr != nil {
			return ScreenManifest{}, readErr
		}
		if !entry.directory {
			digests[entry.path] = digest
		}
		if capture {
			manifestJSON = data
		}
	}

	manifest, err := parseScreenManifest(manifestJSON)
	if err != nil {
		return ScreenManifest{}, err
	}
	if manifest.ScreenID == "" || manifest.ScreenID != screenID {
		return ScreenManifest{}, invalidScreenBundle("manifest screenId 与目标大屏不一致")
	}
	if _, err = parseStableSemver(manifest.Version); err != nil {
		return ScreenManifest{}, invalidScreenBundle("manifest version 必须是稳定 SemVer")
	}
	if manifest.ContainerAPIVersion != ScreenContainerAPIVersion {
		return ScreenManifest{}, invalidScreenBundle("manifest containerApiVersion 不受支持")
	}
	if len(manifest.Files) != payloadFileCount {
		return ScreenManifest{}, invalidScreenBundle("manifest files 与 ZIP 文件清单不一致")
	}
	listedExact := make(map[string]struct{}, len(manifest.Files))
	listedFolded := make(map[string]struct{}, len(manifest.Files))
	for _, listedFile := range manifest.Files {
		if err = ctx.Err(); err != nil {
			return ScreenManifest{}, err
		}
		_, normalizedPath, pathErr := validateScreenBundlePath(listedFile.Path, false)
		if pathErr != nil {
			return ScreenManifest{}, pathErr
		}
		if listedFile.Path == "manifest.json" {
			return ScreenManifest{}, invalidScreenBundle("manifest files 不能包含 manifest.json")
		}
		caseFolded := strings.ToLower(normalizedPath)
		if _, exists := listedFolded[caseFolded]; exists {
			return ScreenManifest{}, invalidScreenBundle("manifest files 包含不区分大小写的重复路径")
		}
		listedExact[normalizedPath] = struct{}{}
		listedFolded[caseFolded] = struct{}{}
		digest, exists := digests[listedFile.Path]
		if !exists {
			return ScreenManifest{}, invalidScreenBundle("manifest files 包含 ZIP 中不存在的文件")
		}
		if listedFile.Size < 0 || listedFile.Size != digest.size {
			return ScreenManifest{}, invalidScreenBundle("manifest 文件大小与 ZIP 内容不一致")
		}
		if !screenSHA256Pattern.MatchString(listedFile.SHA256) || listedFile.SHA256 != digest.sha256 {
			return ScreenManifest{}, invalidScreenBundle("manifest 文件摘要与 ZIP 内容不一致")
		}
	}
	if _, _, err = validateScreenBundlePath(manifest.Entry, false); err != nil {
		return ScreenManifest{}, err
	}
	extension := strings.ToLower(path.Ext(manifest.Entry))
	if extension != ".html" && extension != ".htm" {
		return ScreenManifest{}, invalidScreenBundle("manifest entry 必须是 HTML 文件")
	}
	if _, exists := listedExact[manifest.Entry]; !exists {
		return ScreenManifest{}, invalidScreenBundle("manifest entry 不在 files 清单中")
	}
	return manifest, nil
}

func screenPreflightZIP(file *os.File, size int64) (int, error) {
	var signature [4]byte
	if _, err := file.ReadAt(signature[:], 0); err != nil || !bytes.Equal(signature[:], []byte{'P', 'K', 3, 4}) {
		return 0, invalidScreenBundle("ZIP 必须从本地文件头开始")
	}
	const maxEOCDSearch = int64(22 + 65535 + 20)
	tailSize := size
	if tailSize > maxEOCDSearch {
		tailSize = maxEOCDSearch
	}
	tail := make([]byte, int(tailSize))
	if _, err := file.ReadAt(tail, size-tailSize); err != nil {
		return 0, invalidScreenBundle("无法读取 ZIP 中央目录")
	}
	eocd := -1
	for index := len(tail) - 22; index >= 0; index-- {
		if binary.LittleEndian.Uint32(tail[index:index+4]) != 0x06054b50 {
			continue
		}
		commentLength := int(binary.LittleEndian.Uint16(tail[index+20 : index+22]))
		if index+22+commentLength == len(tail) {
			eocd = index
			break
		}
	}
	if eocd < 0 {
		return 0, invalidScreenBundle("ZIP 缺少有效的中央目录结束记录")
	}
	if eocd >= 20 && binary.LittleEndian.Uint32(tail[eocd-20:eocd-16]) == 0x07064b50 {
		return 0, invalidScreenBundle("大屏资源包不支持 ZIP64")
	}
	disk := binary.LittleEndian.Uint16(tail[eocd+4 : eocd+6])
	centralDisk := binary.LittleEndian.Uint16(tail[eocd+6 : eocd+8])
	diskEntries := binary.LittleEndian.Uint16(tail[eocd+8 : eocd+10])
	totalEntries := binary.LittleEndian.Uint16(tail[eocd+10 : eocd+12])
	centralSize := binary.LittleEndian.Uint32(tail[eocd+12 : eocd+16])
	centralOffset := binary.LittleEndian.Uint32(tail[eocd+16 : eocd+20])
	if disk == 0xffff || centralDisk == 0xffff || diskEntries == 0xffff || totalEntries == 0xffff || centralSize == 0xffffffff || centralOffset == 0xffffffff {
		return 0, invalidScreenBundle("大屏资源包不支持 ZIP64")
	}
	if disk != 0 || centralDisk != 0 || diskEntries != totalEntries {
		return 0, invalidScreenBundle("大屏资源包不支持多卷 ZIP")
	}
	if totalEntries == 0 || totalEntries > screenMaxZIPEntries {
		return 0, invalidScreenBundle("ZIP 条目数量无效或超过限制")
	}
	eocdOffset := uint64(size-tailSize) + uint64(eocd)
	centralEnd := uint64(centralOffset) + uint64(centralSize)
	if centralEnd != eocdOffset || centralEnd > uint64(size) {
		return 0, invalidScreenBundle("ZIP 中央目录边界无效")
	}
	if err := screenValidateZIPDirectory(file, uint64(centralOffset), centralEnd, int(totalEntries)); err != nil {
		return 0, err
	}
	return int(totalEntries), nil
}

func screenValidateZIPDirectory(file *os.File, centralOffset, centralEnd uint64, declaredEntries int) error {
	const centralHeaderSize = uint64(46)
	cursor := centralOffset
	count := 0
	localRanges := make([][2]uint64, 0, declaredEntries)
	for cursor < centralEnd {
		if count >= declaredEntries || centralEnd-cursor < centralHeaderSize {
			return invalidScreenBundle("ZIP 中央目录条目数量或边界无效")
		}
		var header [centralHeaderSize]byte
		if _, err := file.ReadAt(header[:], int64(cursor)); err != nil {
			return invalidScreenBundle("无法读取 ZIP 中央目录条目")
		}
		if binary.LittleEndian.Uint32(header[0:4]) != 0x02014b50 {
			return invalidScreenBundle("ZIP 中央目录条目签名无效")
		}
		flags := binary.LittleEndian.Uint16(header[8:10])
		method := binary.LittleEndian.Uint16(header[10:12])
		crc := binary.LittleEndian.Uint32(header[16:20])
		compressedSize := binary.LittleEndian.Uint32(header[20:24])
		uncompressedSize := binary.LittleEndian.Uint32(header[24:28])
		nameLength := uint64(binary.LittleEndian.Uint16(header[28:30]))
		extraLength := uint64(binary.LittleEndian.Uint16(header[30:32]))
		commentLength := uint64(binary.LittleEndian.Uint16(header[32:34]))
		disk := binary.LittleEndian.Uint16(header[34:36])
		localOffset := binary.LittleEndian.Uint32(header[42:46])
		if disk != 0 {
			return invalidScreenBundle("大屏资源包不支持多卷 ZIP")
		}
		if compressedSize == 0xffffffff || uncompressedSize == 0xffffffff || localOffset == 0xffffffff {
			return invalidScreenBundle("大屏资源包不支持 ZIP64")
		}
		if nameLength == 0 || nameLength > 240 {
			return invalidScreenBundle("ZIP 路径长度无效或超过限制")
		}
		next := cursor + centralHeaderSize + nameLength + extraLength + commentLength
		if next < cursor || next > centralEnd {
			return invalidScreenBundle("ZIP 中央目录条目边界无效")
		}
		name := make([]byte, int(nameLength))
		if nameLength > 0 {
			if _, err := file.ReadAt(name, int64(cursor+centralHeaderSize)); err != nil {
				return invalidScreenBundle("无法读取 ZIP 中央目录文件名")
			}
		}
		extra := make([]byte, int(extraLength))
		if extraLength > 0 {
			if _, err := file.ReadAt(extra, int64(cursor+centralHeaderSize+nameLength)); err != nil {
				return invalidScreenBundle("无法读取 ZIP 中央目录扩展字段")
			}
		}
		if err := screenValidateZIPExtra(extra); err != nil {
			return err
		}
		localStart, localEnd, err := screenValidateZIPLocalHeader(file, uint64(localOffset), centralOffset, name, flags, method, crc, compressedSize, uncompressedSize)
		if err != nil {
			return err
		}
		localRanges = append(localRanges, [2]uint64{localStart, localEnd})
		count++
		cursor = next
	}
	if cursor != centralEnd || count != declaredEntries {
		return invalidScreenBundle("ZIP 中央目录条目数量或边界无效")
	}
	sort.Slice(localRanges, func(left, right int) bool {
		return localRanges[left][0] < localRanges[right][0]
	})
	for index := 1; index < len(localRanges); index++ {
		if localRanges[index][0] < localRanges[index-1][1] {
			return invalidScreenBundle("ZIP 本地文件条目范围重叠")
		}
	}
	return nil
}

func screenValidateZIPLocalHeader(file *os.File, offset, centralOffset uint64, centralName []byte, centralFlags, centralMethod uint16, centralCRC, centralCompressedSize, centralUncompressedSize uint32) (uint64, uint64, error) {
	const localHeaderSize = uint64(30)
	if offset+localHeaderSize < offset || offset+localHeaderSize > centralOffset {
		return 0, 0, invalidScreenBundle("ZIP 本地文件头边界无效")
	}
	var header [localHeaderSize]byte
	if _, err := file.ReadAt(header[:], int64(offset)); err != nil {
		return 0, 0, invalidScreenBundle("无法读取 ZIP 本地文件头")
	}
	if binary.LittleEndian.Uint32(header[0:4]) != 0x04034b50 {
		return 0, 0, invalidScreenBundle("ZIP 本地文件头签名无效")
	}
	flags := binary.LittleEndian.Uint16(header[6:8])
	method := binary.LittleEndian.Uint16(header[8:10])
	crc := binary.LittleEndian.Uint32(header[14:18])
	compressedSize := binary.LittleEndian.Uint32(header[18:22])
	uncompressedSize := binary.LittleEndian.Uint32(header[22:26])
	nameLength := uint64(binary.LittleEndian.Uint16(header[26:28]))
	extraLength := uint64(binary.LittleEndian.Uint16(header[28:30]))
	if flags != centralFlags || method != centralMethod {
		return 0, 0, invalidScreenBundle("ZIP 本地文件头与中央目录不一致")
	}
	if nameLength != uint64(len(centralName)) {
		return 0, 0, invalidScreenBundle("ZIP 本地文件名与中央目录不一致")
	}
	if compressedSize == 0xffffffff || uncompressedSize == 0xffffffff {
		return 0, 0, invalidScreenBundle("大屏资源包不支持 ZIP64")
	}
	bodyOffset := offset + localHeaderSize + nameLength + extraLength
	dataEnd := bodyOffset + uint64(centralCompressedSize)
	if bodyOffset < offset || dataEnd < bodyOffset || dataEnd > centralOffset {
		return 0, 0, invalidScreenBundle("ZIP 本地文件数据边界无效")
	}
	name := make([]byte, int(nameLength))
	if nameLength > 0 {
		if _, err := file.ReadAt(name, int64(offset+localHeaderSize)); err != nil {
			return 0, 0, invalidScreenBundle("无法读取 ZIP 本地文件名")
		}
	}
	if !bytes.Equal(name, centralName) {
		return 0, 0, invalidScreenBundle("ZIP 本地文件名与中央目录不一致")
	}
	extra := make([]byte, int(extraLength))
	if extraLength > 0 {
		if _, err := file.ReadAt(extra, int64(offset+localHeaderSize+nameLength)); err != nil {
			return 0, 0, invalidScreenBundle("无法读取 ZIP 本地扩展字段")
		}
	}
	if err := screenValidateZIPExtra(extra); err != nil {
		return 0, 0, err
	}
	if flags&(1<<3) == 0 {
		if crc != centralCRC || compressedSize != centralCompressedSize || uncompressedSize != centralUncompressedSize {
			return 0, 0, invalidScreenBundle("ZIP 本地文件头大小或 CRC 与中央目录不一致")
		}
	} else if (crc != 0 && crc != centralCRC) || (compressedSize != 0 && compressedSize != centralCompressedSize) || (uncompressedSize != 0 && uncompressedSize != centralUncompressedSize) {
		return 0, 0, invalidScreenBundle("ZIP 本地文件头大小或 CRC 与中央目录不一致")
	}
	entryEnd := dataEnd
	if flags&(1<<3) != 0 {
		var descriptor [16]byte
		if dataEnd+12 < dataEnd || dataEnd+12 > centralOffset {
			return 0, 0, invalidScreenBundle("ZIP 数据描述符边界无效")
		}
		if _, err := file.ReadAt(descriptor[:12], int64(dataEnd)); err != nil {
			return 0, 0, invalidScreenBundle("无法读取 ZIP 数据描述符")
		}
		descriptorOffset := 0
		descriptorLength := uint64(12)
		if binary.LittleEndian.Uint32(descriptor[0:4]) == 0x08074b50 {
			if dataEnd+16 < dataEnd || dataEnd+16 > centralOffset {
				return 0, 0, invalidScreenBundle("ZIP 数据描述符边界无效")
			}
			if _, err := file.ReadAt(descriptor[12:16], int64(dataEnd+12)); err != nil {
				return 0, 0, invalidScreenBundle("无法读取 ZIP 数据描述符")
			}
			descriptorOffset = 4
			descriptorLength = 16
		}
		if binary.LittleEndian.Uint32(descriptor[descriptorOffset:descriptorOffset+4]) != centralCRC || binary.LittleEndian.Uint32(descriptor[descriptorOffset+4:descriptorOffset+8]) != centralCompressedSize || binary.LittleEndian.Uint32(descriptor[descriptorOffset+8:descriptorOffset+12]) != centralUncompressedSize {
			return 0, 0, invalidScreenBundle("ZIP 数据描述符与中央目录不一致")
		}
		entryEnd += descriptorLength
	}
	return offset, entryEnd, nil
}

func screenValidateZIPExtra(extra []byte) error {
	for len(extra) > 0 {
		if len(extra) < 4 {
			return invalidScreenBundle("ZIP 扩展字段无效")
		}
		fieldID := binary.LittleEndian.Uint16(extra[0:2])
		fieldSize := int(binary.LittleEndian.Uint16(extra[2:4]))
		extra = extra[4:]
		if fieldSize > len(extra) {
			return invalidScreenBundle("ZIP 扩展字段无效")
		}
		if fieldID == 0x0001 {
			return invalidScreenBundle("大屏资源包不支持 ZIP64")
		}
		if fieldID == 0x7075 {
			return invalidScreenBundle("ZIP 路径不能使用 Unicode 替代字段")
		}
		if fieldID == 0x9901 {
			return invalidScreenBundle("大屏资源包不能加密")
		}
		extra = extra[fieldSize:]
	}
	return nil
}

func validateScreenBundlePath(value string, directory bool) ([]string, string, error) {
	if value == "" || len(value) > 240 || strings.HasPrefix(value, "/") || strings.Contains(value, "\\") {
		return nil, "", invalidScreenBundle("ZIP 路径不是安全的可移植相对路径")
	}
	for index := 0; index < len(value); index++ {
		character := value[index]
		if !(character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' || character >= '0' && character <= '9' || character == '-' || character == '_' || character == '.' || character == '/') {
			return nil, "", invalidScreenBundle("ZIP 路径只能使用可移植 ASCII 字符")
		}
	}
	normalized := value
	if directory {
		if !strings.HasSuffix(normalized, "/") {
			return nil, "", invalidScreenBundle("ZIP 目录路径必须以斜杠结尾")
		}
		normalized = strings.TrimSuffix(normalized, "/")
	} else if strings.HasSuffix(normalized, "/") {
		return nil, "", invalidScreenBundle("ZIP 文件路径不能以斜杠结尾")
	}
	parts := strings.Split(normalized, "/")
	if len(parts) == 0 || len(parts) > 16 {
		return nil, "", invalidScreenBundle("ZIP 路径深度超过限制")
	}
	for _, part := range parts {
		if part == "" || part == "." || part == ".." || strings.HasSuffix(part, ".") || screenWindowsReservedName(part) {
			return nil, "", invalidScreenBundle("ZIP 路径包含空段、父目录或保留文件名")
		}
	}
	return parts, normalized, nil
}

func screenWindowsReservedName(segment string) bool {
	base := strings.ToUpper(segment)
	if dot := strings.IndexByte(base, '.'); dot >= 0 {
		base = base[:dot]
	}
	if base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" {
		return true
	}
	return len(base) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) && base[3] >= '1' && base[3] <= '9'
}

func registerScreenBundlePath(parts []string, normalized string, directory bool, entries map[string]struct{}, nodes map[string]screenPathNode) error {
	caseFolded := strings.ToLower(normalized)
	if _, exists := entries[caseFolded]; exists {
		return invalidScreenBundle("ZIP 包含不区分大小写的重复路径")
	}
	entries[caseFolded] = struct{}{}
	for index := 1; index < len(parts); index++ {
		spelling := strings.Join(parts[:index], "/")
		key := strings.ToLower(spelling)
		if node, exists := nodes[key]; exists {
			if !node.directory {
				return invalidScreenBundle("ZIP 包含文件与目录路径冲突")
			}
			if node.spelling != spelling {
				return invalidScreenBundle("ZIP 目录路径存在不区分大小写的冲突")
			}
		} else {
			nodes[key] = screenPathNode{directory: true, spelling: spelling}
		}
	}
	if node, exists := nodes[caseFolded]; exists {
		if !directory || !node.directory {
			return invalidScreenBundle("ZIP 包含文件与目录路径冲突")
		}
		if node.spelling != normalized {
			return invalidScreenBundle("ZIP 目录路径存在不区分大小写的冲突")
		}
	} else {
		nodes[caseFolded] = screenPathNode{directory: directory, spelling: normalized}
	}
	return nil
}

func screenCompressionRatioExceeded(uncompressed, compressed uint64) bool {
	if uncompressed == 0 {
		return false
	}
	if compressed == 0 {
		return true
	}
	minimumCompressed := (uncompressed + ScreenMaxCompressionRatio - 1) / ScreenMaxCompressionRatio
	return compressed < minimumCompressed
}

func readScreenZIPEntry(ctx context.Context, item *zip.File, limit int64, capture, directory bool) ([]byte, screenEntryDigest, error) {
	var reader io.ReadCloser
	var err error
	if directory {
		var raw io.Reader
		raw, err = item.OpenRaw()
		if err == nil {
			switch item.Method {
			case zip.Store:
				reader = io.NopCloser(raw)
			case zip.Deflate:
				reader = flate.NewReader(raw)
			}
		}
	} else {
		reader, err = item.Open()
	}
	if err != nil {
		return nil, screenEntryDigest{}, invalidScreenBundle("无法读取 ZIP 条目")
	}
	defer reader.Close()
	sha := sha256.New()
	crc := crc32.NewIEEE()
	var captured bytes.Buffer
	buffer := make([]byte, 32<<10)
	var size int64
	for {
		if err = ctx.Err(); err != nil {
			return nil, screenEntryDigest{}, err
		}
		count, readErr := reader.Read(buffer)
		if count > 0 {
			size += int64(count)
			if directory {
				return nil, screenEntryDigest{}, invalidScreenBundle("ZIP 目录条目必须为空")
			}
			if size > limit {
				return nil, screenEntryDigest{}, screenBundleTooLarge("ZIP 条目展开大小超过限制")
			}
			_, _ = sha.Write(buffer[:count])
			_, _ = crc.Write(buffer[:count])
			if capture {
				_, _ = captured.Write(buffer[:count])
			}
		}
		if readErr != nil {
			if errors.Is(readErr, io.EOF) {
				break
			}
			return nil, screenEntryDigest{}, invalidScreenBundle("ZIP 条目内容或 CRC 无效")
		}
	}
	if uint64(size) != item.UncompressedSize64 || crc.Sum32() != item.CRC32 {
		return nil, screenEntryDigest{}, invalidScreenBundle("ZIP 条目大小或 CRC 无效")
	}
	return captured.Bytes(), screenEntryDigest{size: size, sha256: hex.EncodeToString(sha.Sum(nil))}, nil
}

func parseScreenManifest(data []byte) (ScreenManifest, error) {
	if len(data) == 0 || int64(len(data)) > ScreenMaxManifestBytes {
		return ScreenManifest{}, invalidScreenBundle("manifest.json 为空或超过大小限制")
	}
	if !utf8.Valid(data) {
		return ScreenManifest{}, invalidScreenBundle("manifest.json 必须使用有效 UTF-8 编码")
	}
	if err := rejectScreenJSONDuplicateKeys(data); err != nil {
		return ScreenManifest{}, err
	}
	var root map[string]json.RawMessage
	if err := json.Unmarshal(data, &root); err != nil || root == nil {
		return ScreenManifest{}, invalidScreenBundle("manifest.json 必须是 JSON 对象")
	}
	required := []string{"screenId", "version", "entry", "containerApiVersion", "files"}
	if len(root) != len(required) {
		return ScreenManifest{}, invalidScreenBundle("manifest.json 字段不完整或包含未知字段")
	}
	for _, key := range required {
		if _, exists := root[key]; !exists {
			return ScreenManifest{}, invalidScreenBundle("manifest.json 字段不完整或包含未知字段")
		}
	}
	var fileObjects []json.RawMessage
	if err := json.Unmarshal(root["files"], &fileObjects); err != nil || fileObjects == nil {
		return ScreenManifest{}, invalidScreenBundle("manifest files 必须是数组")
	}
	for _, raw := range fileObjects {
		var object map[string]json.RawMessage
		if err := json.Unmarshal(raw, &object); err != nil || object == nil || len(object) != 3 {
			return ScreenManifest{}, invalidScreenBundle("manifest files 项字段无效")
		}
		for _, key := range []string{"path", "size", "sha256"} {
			if _, exists := object[key]; !exists {
				return ScreenManifest{}, invalidScreenBundle("manifest files 项字段无效")
			}
		}
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	var manifest ScreenManifest
	if err := decoder.Decode(&manifest); err != nil {
		return ScreenManifest{}, invalidScreenBundle("manifest.json 类型或字段无效")
	}
	if err := ensureScreenJSONEOF(decoder); err != nil {
		return ScreenManifest{}, err
	}
	return manifest, nil
}

func rejectScreenJSONDuplicateKeys(data []byte) error {
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	first, err := decoder.Token()
	if err != nil {
		return invalidScreenBundle("manifest.json 不是有效 JSON")
	}
	if err = walkScreenJSONValue(decoder, first, 1); err != nil {
		return err
	}
	return ensureScreenJSONEOF(decoder)
}

func walkScreenJSONValue(decoder *json.Decoder, first json.Token, depth int) error {
	delimiter, isDelimiter := first.(json.Delim)
	if !isDelimiter {
		return nil
	}
	if depth > 16 {
		return invalidScreenBundle("manifest.json 嵌套深度超过限制")
	}
	switch delimiter {
	case '{':
		keys := map[string]struct{}{}
		for decoder.More() {
			keyToken, err := decoder.Token()
			if err != nil {
				return invalidScreenBundle("manifest.json 不是有效 JSON")
			}
			key, ok := keyToken.(string)
			if !ok {
				return invalidScreenBundle("manifest.json 对象键无效")
			}
			if _, exists := keys[key]; exists {
				return invalidScreenBundle("manifest.json 包含重复键")
			}
			keys[key] = struct{}{}
			value, err := decoder.Token()
			if err != nil {
				return invalidScreenBundle("manifest.json 不是有效 JSON")
			}
			if err = walkScreenJSONValue(decoder, value, depth+1); err != nil {
				return err
			}
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim('}') {
			return invalidScreenBundle("manifest.json 对象未正确结束")
		}
	case '[':
		for decoder.More() {
			value, err := decoder.Token()
			if err != nil {
				return invalidScreenBundle("manifest.json 不是有效 JSON")
			}
			if err = walkScreenJSONValue(decoder, value, depth+1); err != nil {
				return err
			}
		}
		end, err := decoder.Token()
		if err != nil || end != json.Delim(']') {
			return invalidScreenBundle("manifest.json 数组未正确结束")
		}
	default:
		return invalidScreenBundle("manifest.json 结构无效")
	}
	return nil
}

func ensureScreenJSONEOF(decoder *json.Decoder) error {
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return invalidScreenBundle("manifest.json 只能包含一个 JSON 值")
	}
	return nil
}
