//go:build !linux

package updater

import "sync"

var planMutex sync.Mutex

func maintenanceLock(string) (func(), error) { planMutex.Lock(); return planMutex.Unlock, nil }
