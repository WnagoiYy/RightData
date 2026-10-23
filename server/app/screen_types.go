package app

import "time"

const (
	ScreenContainerAPIVersion       = 1
	ScreenMaxArchiveBytes     int64 = 50 << 20
	ScreenMaxExpandedBytes    int64 = 200 << 20
	ScreenMaxFileBytes        int64 = 32 << 20
	ScreenMaxManifestBytes    int64 = 1 << 20
	ScreenMaxFiles                  = 2048
	ScreenMaxCompressionRatio       = 100
)

type ScreenManifestFile struct {
	Path   string `json:"path"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

type ScreenManifest struct {
	ScreenID            string               `json:"screenId"`
	Version             string               `json:"version"`
	Entry               string               `json:"entry"`
	ContainerAPIVersion int                  `json:"containerApiVersion"`
	Files               []ScreenManifestFile `json:"files"`
}

// ScreenVersion describes the original immutable ZIP. Files excludes manifest.json.
type ScreenVersion struct {
	ScreenManifest
	SHA256      string    `json:"sha256"`
	SizeBytes   int64     `json:"sizeBytes"`
	CreatedAt   time.Time `json:"createdAt"`
	DownloadURL string    `json:"downloadUrl"`
}

type ScreenPublication struct {
	PublishedVersion *ScreenVersion `json:"publishedVersion"`
	PublishRevision  int64          `json:"publishRevision"`
	PublishedAt      *time.Time     `json:"publishedAt"`
}
