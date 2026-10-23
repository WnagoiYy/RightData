//go:build !windows

package app

import (
	"errors"
	"golang.org/x/sys/unix"
	"os"
)

func platformProtect(data []byte, decrypt bool) ([]byte, error) {
	return nil, errors.New("此系统须配置 RIGHTDATA_MASTER_KEY 保护启动凭据")
}
func lockInstance(path string) (func(), error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		f.Close()
		return nil, err
	}
	return func() { unix.Flock(int(f.Fd()), unix.LOCK_UN); f.Close() }, nil
}
