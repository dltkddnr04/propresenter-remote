//go:build darwin

package menubar

/*
#cgo darwin LDFLAGS: -framework Cocoa -framework CoreImage
#include <stdlib.h>
#include "menubar_darwin.h"
*/
import "C"

import (
	"runtime"
	"unsafe"
)

type Callbacks struct {
	Open      func()
	Configure func()
	Quit      func()
}

var callbacks Callbacks

//export goMenuOpen
func goMenuOpen() {
	if callbacks.Open != nil {
		go callbacks.Open()
	}
}

//export goMenuConfigure
func goMenuConfigure() {
	if callbacks.Configure != nil {
		go callbacks.Configure()
	}
}

//export goMenuQuit
func goMenuQuit() {
	if callbacks.Quit != nil {
		go callbacks.Quit()
	}
}

func Run(accessURL string, next Callbacks) error {
	callbacks = next
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	url := C.CString(accessURL)
	defer C.free(unsafe.Pointer(url))
	C.proPresenterMenuStart(url)
	C.proPresenterMenuRun()
	return nil
}

func Quit() {
	C.proPresenterMenuQuit()
}
