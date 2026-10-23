package system

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

func TestCommandBoundsInheritedOutputPipes(t *testing.T) {
	for _, cancelRunning := range []bool{false, true} {
		name := "exited parent"
		if cancelRunning {
			name = "canceled parent"
		}
		t.Run(name, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			pidFile := filepath.Join(t.TempDir(), "descendant.pid")
			mode := "exit"
			if cancelRunning {
				mode = "wait"
			}
			finished := make(chan error, 1)
			go func() {
				_, err := Command(ctx, os.Args[0], "-test.run=^TestCommandSubprocess$", "--", mode, pidFile)
				finished <- err
			}()
			var descendant *os.Process
			defer func() {
				if descendant != nil {
					_ = descendant.Kill()
					_ = descendant.Release()
				}
			}()
			deadline := time.Now().Add(10 * time.Second)
			for descendant == nil {
				body, err := os.ReadFile(pidFile)
				if err == nil {
					pid, err := strconv.Atoi(string(body))
					if err != nil {
						t.Fatal(err)
					}
					descendant, err = os.FindProcess(pid)
					if err != nil {
						t.Fatal(err)
					}
					break
				}
				if !os.IsNotExist(err) || time.Now().After(deadline) {
					t.Fatalf("helper did not create descendant: %v", err)
				}
				time.Sleep(10 * time.Millisecond)
			}
			if cancelRunning {
				cancel()
			}
			select {
			case err := <-finished:
				if err == nil {
					t.Fatal("command with unsettled output unexpectedly succeeded")
				}
				if !cancelRunning && !errors.Is(err, exec.ErrWaitDelay) {
					t.Fatalf("expected an inherited pipe timeout, got %v", err)
				}
			case <-time.After(3 * time.Second):
				cancel()
				_ = descendant.Kill()
				<-finished
				t.Fatal("command remained blocked by inherited output after its parent exited")
			}
		})
	}
}

// Re-exec the test executable to exercise real operating-system pipe inheritance.
func TestCommandSubprocess(t *testing.T) {
	args := os.Args
	if len(args) < 4 || args[len(args)-3] != "--" {
		return
	}
	mode, pidFile := args[len(args)-2], args[len(args)-1]
	if mode == "hold" {
		time.Sleep(30 * time.Second)
		os.Exit(0)
	}
	child := exec.Command(os.Args[0], "-test.run=^TestCommandSubprocess$", "--", "hold", pidFile)
	child.Stdout, child.Stderr = os.Stdout, os.Stderr
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	temporaryPIDFile := pidFile + ".tmp"
	if err := os.WriteFile(temporaryPIDFile, []byte(strconv.Itoa(child.Process.Pid)), 0600); err != nil {
		_ = child.Process.Kill()
		t.Fatal(err)
	}
	if err := os.Rename(temporaryPIDFile, pidFile); err != nil {
		_ = child.Process.Kill()
		t.Fatal(err)
	}
	if mode == "wait" {
		time.Sleep(30 * time.Second)
	}
	os.Exit(0)
}
