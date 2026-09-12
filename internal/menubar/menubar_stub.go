//go:build !darwin

package menubar

import "errors"

var ErrUnsupported = errors.New("macOS menu bar is only available on darwin")

type Callbacks struct {
	Open      func()
	Configure func()
	Quit      func()
}

func Run(string, Callbacks) error { return ErrUnsupported }

func Quit() {}
