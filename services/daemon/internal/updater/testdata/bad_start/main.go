// A candidate that passes the real compatibility and database checks but exits
// when systemd starts it, exercising rollback after an actual executable switch.
package main

import (
	"os"
	"os/exec"
)

var reference = "/fixtures/new"

func main() {
	for _, argument := range os.Args[1:] {
		if argument == "-capabilities" || argument == "-check" {
			command := exec.Command(reference, os.Args[1:]...)
			command.Stdout = os.Stdout
			command.Stderr = os.Stderr
			if err := command.Run(); err != nil {
				os.Exit(1)
			}
			return
		}
	}
	os.Exit(42)
}
