//go:build !windows

package app

import (
	"fmt"
	"os"
	"path/filepath"
)

func persistScreenBundle(source, destination string) error {
	if err := os.Rename(source, destination); err != nil {
		return err
	}
	directory, err := os.Open(filepath.Dir(destination))
	if err == nil {
		err = directory.Sync()
		_ = directory.Close()
	}
	if err == nil {
		return nil
	}
	// The caller treats an error as an uncommitted upload and still owns the
	// source path. Restore that state when durability cannot be established.
	rollbackErr := os.Rename(destination, source)
	return fmt.Errorf("persist screen bundle directory: %w (rollback: %v)", err, rollbackErr)
}

func screenStorageSafeRegular(_ string, info os.FileInfo) bool {
	return info != nil && info.Mode().IsRegular() && info.Mode()&os.ModeSymlink == 0
}

func screenStoragePathKey(path string) string {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return filepath.Clean(path)
	}
	return filepath.Clean(absolute)
}
