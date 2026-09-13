package updater

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"time"

	"github.com/Zxilly/bifurcation/services/daemon/gen/bifurcation/v1/bifurcationv1connect"
	"github.com/Zxilly/bifurcation/services/daemon/internal/identity"
	"github.com/Zxilly/bifurcation/services/daemon/internal/state"
	"github.com/Zxilly/bifurcation/services/daemon/internal/system"
)

const InstalledBinary = "/usr/local/bin/bifurcation-daemon"
const RecoveryBinary = "/usr/local/libexec/bifurcation-recovery"
const DaemonUnit = "bifurcation-daemon.service"
const UninstallUnit = "bifurcation-uninstall-recovery.service"
const unitDirectory = "/etc/systemd/system"

var ErrHandedOff = errors.New("maintenance task handed to independent helper")
var safeTaskID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

type Capabilities struct {
	Version             string `json:"version"`
	OS                  string `json:"os"`
	Arch                string `json:"arch"`
	SchemaFingerprint   string `json:"schemaFingerprint"`
	MaintenanceProtocol int    `json:"maintenanceProtocol"`
}

func Describe(version string) Capabilities {
	return Capabilities{Version: version, OS: runtime.GOOS, Arch: runtime.GOARCH, SchemaFingerprint: state.SchemaFingerprint(), MaintenanceProtocol: 1}
}

type Plan struct {
	Format      int    `json:"format"`
	Kind        string `json:"kind"`
	TaskID      string `json:"taskId"`
	PayloadHash string `json:"payloadHash"`
	Phase       string `json:"phase"`
	HelperUnit  string `json:"helperUnit"`
	ConfigPath  string `json:"configPath"`
	Backup      string `json:"backup"`
	Candidate   string `json:"candidate"`
	Helper      string `json:"helper"`
	OldVersion  string `json:"oldVersion"`
	NewVersion  string `json:"newVersion"`
	OldSHA256   string `json:"oldSha256"`
	NewSHA256   string `json:"newSha256"`
	LocalIssue  string `json:"localIssue,omitempty"`
	StartAfter  int64  `json:"startAfter,omitempty"`
	UpdatedAt   int64  `json:"updatedAt"`
}

type Controller struct {
	config              identity.Config
	configPath, version string
	store               *state.Store
	rpc                 bifurcationv1connect.MachineServiceClient
}

func New(config identity.Config, configPath, version string, store *state.Store) *Controller {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = 15 * time.Second
	httpClient := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	absolute, _ := filepath.Abs(configPath)
	return &Controller{config: config, configPath: absolute, version: version, store: store, rpc: bifurcationv1connect.NewMachineServiceClient(httpClient, config.PanelURL+"/rpc")}
}
func (c *Controller) planPath(kind string) string {
	return filepath.Join(c.config.StateDirectory, "updater", kind+".json")
}
func (c *Controller) taskDirectory(id string) string {
	return filepath.Join(c.config.StateDirectory, "updater", id)
}
func (c *Controller) load(kind string) (*Plan, error) {
	data, err := os.ReadFile(c.planPath(kind))
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var plan Plan
	if err = json.Unmarshal(data, &plan); err != nil {
		return nil, err
	}
	if plan.Format != 1 || plan.Kind != kind || !safeTaskID.MatchString(plan.TaskID) || filepath.Clean(plan.ConfigPath) != filepath.Clean(c.configPath) {
		return nil, errors.New("invalid maintenance recovery plan")
	}
	directory := c.taskDirectory(plan.TaskID)
	if plan.Helper != filepath.Join(directory, "helper") || plan.Backup != "" && plan.Backup != filepath.Join(directory, "previous-daemon") || plan.Candidate != "" && plan.Candidate != filepath.Join(filepath.Dir(InstalledBinary), ".bifurcation-candidate-"+plan.TaskID) {
		return nil, errors.New("maintenance plan contains unexpected filesystem paths")
	}
	return &plan, nil
}
func (c *Controller) save(plan *Plan) error {
	unlock, err := maintenanceLock(filepath.Join(c.config.StateDirectory, "updater"))
	if err != nil {
		return err
	}
	defer unlock()
	existing, err := c.load(plan.Kind)
	if err != nil {
		return err
	}
	if existing != nil && existing.TaskID == plan.TaskID && existing.Phase == "completed" && plan.Phase != "updater_ready" {
		return nil
	}
	if existing != nil && existing.TaskID != plan.TaskID && plan.Phase == "completed" {
		return nil
	}
	plan.UpdatedAt = time.Now().UnixMilli()
	body, err := json.Marshal(plan)
	if err != nil {
		return err
	}
	return system.AtomicWrite(c.planPath(plan.Kind), body, 0600)
}
func (c *Controller) Active(taskID string) (bool, error) {
	for _, kind := range []string{"upgrade", "uninstall"} {
		plan, err := c.load(kind)
		if err != nil {
			return false, err
		}
		if plan != nil && plan.TaskID == taskID && plan.Phase != "completed" {
			return true, nil
		}
	}
	return false, nil
}
func (c *Controller) ensureIdle(ctx context.Context) error {
	for _, kind := range []string{"upgrade", "uninstall"} {
		plan, err := c.load(kind)
		if err != nil {
			return err
		}
		if plan == nil || plan.Phase == "completed" {
			continue
		}
		task, err := c.store.Task(ctx, plan.TaskID)
		if err != nil {
			return err
		}
		if !task.Acknowledged {
			return errors.New("another maintenance operation is awaiting completion")
		}
	}
	return nil
}
func (c *Controller) validateInstallation() error {
	if runtime.GOOS != "linux" {
		return errors.New("maintenance requires a systemd installation")
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		return err
	}
	if executable != InstalledBinary {
		return errors.New("maintenance requires the standard installed daemon path")
	}
	if !filepath.IsAbs(c.config.StateDirectory) || filepath.Clean(c.config.StateDirectory) == "/" {
		return errors.New("maintenance requires a dedicated absolute state directory")
	}
	for _, path := range []string{InstalledBinary, c.configPath, c.config.StateDirectory} {
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("maintenance refuses symbolic link %s", path)
		}
	}
	unit, err := os.ReadFile(filepath.Join(unitDirectory, DaemonUnit))
	if err != nil {
		return err
	}
	if !strings.Contains(string(unit), "# Managed by Bifurcation installer v1") || !strings.Contains(string(unit), "ExecStart="+InstalledBinary) {
		return errors.New("daemon service is not owned by the Bifurcation installer")
	}
	return nil
}
func helperActive(ctx context.Context, unit string) bool {
	output, err := system.Command(ctx, "systemctl", "show", unit, "--property=ActiveState", "--value")
	if err != nil {
		return false
	}
	switch strings.TrimSpace(output) {
	case "active", "activating", "reloading":
		return true
	default:
		return false
	}
}
func quoteUnit(value string) string {
	return `"` + strings.NewReplacer(`\`, `\\`, `"`, `\"`, `%`, `%%`, "\n", `\n`, "\r", `\r`).Replace(value) + `"`
}
func (c *Controller) Acknowledge(taskID string) error {
	for _, kind := range []string{"upgrade", "uninstall"} {
		plan, err := c.load(kind)
		if err != nil {
			return err
		}
		if plan != nil && plan.TaskID == taskID && kind == "upgrade" {
			plan.Phase = "completed"
			return c.save(plan)
		}
	}
	return nil
}

func (c *Controller) Supported() bool { return c.validateInstallation() == nil }
