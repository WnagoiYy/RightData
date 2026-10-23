package app

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	screenOrphanMinimumAge = 24 * time.Hour
	screenCleanupBatchSize = 128
)

type screenCleanupCandidate struct {
	path string
	info os.FileInfo
}

// CleanupScreenFiles removes only old, unreferenced files whose names can be
// produced by the screen upload path. Database rows are read and closed before
// filesystem work because the system database has a single connection.
func (a *App) CleanupScreenFiles(ctx context.Context, now time.Time) error {
	referenced, err := a.screenReferencedFiles(ctx)
	if err != nil {
		return err
	}

	directory := a.screensDir()
	entries, err := os.ReadDir(directory)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}

	cutoff := now.UTC().Add(-screenOrphanMinimumAge)
	candidates := make([]screenCleanupCandidate, 0, screenCleanupBatchSize)
	for _, entry := range entries {
		if err = ctx.Err(); err != nil {
			return err
		}
		if len(candidates) >= screenCleanupBatchSize {
			break
		}
		if !screenManagedStorageName(entry.Name()) || entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		candidatePath := filepath.Join(directory, entry.Name())
		if !pathWithin(directory, candidatePath) {
			continue
		}
		info, statErr := os.Lstat(candidatePath)
		if statErr != nil || !screenStorageSafeRegular(candidatePath, info) || info.ModTime().After(cutoff) {
			continue
		}
		if referenced[screenStoragePathKey(candidatePath)] {
			continue
		}
		candidates = append(candidates, screenCleanupCandidate{path: candidatePath, info: info})
	}

	for _, candidate := range candidates {
		if err = ctx.Err(); err != nil {
			return err
		}
		if err = a.removeUnreferencedScreenFile(ctx, candidate, cutoff); err != nil {
			return err
		}
	}
	return nil
}

func (a *App) screenReferencedFiles(ctx context.Context) (map[string]bool, error) {
	rows, err := a.DB.QueryContext(ctx, `SELECT path FROM screen_versions`)
	if err != nil {
		return nil, err
	}
	referenced := map[string]bool{}
	for rows.Next() {
		var path string
		if err = rows.Scan(&path); err != nil {
			_ = rows.Close()
			return nil, err
		}
		referenced[screenStoragePathKey(path)] = true
	}
	rowErr := rows.Err()
	closeErr := rows.Close()
	if rowErr != nil {
		return nil, rowErr
	}
	if closeErr != nil {
		return nil, closeErr
	}
	return referenced, nil
}

func (a *App) removeUnreferencedScreenFile(ctx context.Context, candidate screenCleanupCandidate, cutoff time.Time) error {
	tx, err := a.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var references int
	if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM screen_versions WHERE path=?`, candidate.path).Scan(&references); err != nil {
		return err
	}
	if references != 0 {
		return nil
	}

	current, err := os.Lstat(candidate.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return nil
	}
	if !screenStorageSafeRegular(candidate.path, current) || !os.SameFile(candidate.info, current) || current.ModTime().After(cutoff) {
		return nil
	}
	if err = os.Remove(candidate.path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func screenManagedStorageName(name string) bool {
	if strings.HasPrefix(name, ".upload-") && strings.HasSuffix(name, ".zip") {
		digits := name[len(".upload-") : len(name)-len(".zip")]
		if digits == "" {
			return false
		}
		for index := range digits {
			if digits[index] < '0' || digits[index] > '9' {
				return false
			}
		}
		return true
	}
	if len(name) != 48+len(".zip") || !strings.HasSuffix(name, ".zip") {
		return false
	}
	for index := 0; index < 48; index++ {
		character := name[index]
		if !((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f')) {
			return false
		}
	}
	return true
}
