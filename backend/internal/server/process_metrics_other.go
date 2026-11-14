//go:build !linux

package server

func processCPUSeconds() (float64, bool) { return 0, false }
func processSockets() any                { return nil }
