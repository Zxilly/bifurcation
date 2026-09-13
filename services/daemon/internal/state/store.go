package state

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"embed"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	"github.com/Zxilly/bifurcation/services/daemon/internal/state/ent"
	_ "modernc.org/sqlite"
)

//go:embed migrations/*.sql
var migrations embed.FS

// Store owns one SQLite connection; all business writes use Ent transactions.
type Store struct {
	client *ent.Client
	mu     sync.Mutex
}

func Open(ctx context.Context, path string) (*Store, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	sqlitePath := filepath.ToSlash(absolute)
	if !strings.HasPrefix(sqlitePath, "/") {
		sqlitePath = "/" + sqlitePath
	}
	u := url.URL{Scheme: "file", Path: sqlitePath}
	q := u.Query()
	q.Add("_pragma", "foreign_keys(1)")
	q.Add("_pragma", "busy_timeout(5000)")
	q.Add("_pragma", "journal_mode(WAL)")
	u.RawQuery = q.Encode()
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	if err = migrate(ctx, db); err != nil {
		db.Close()
		return nil, err
	}
	return &Store{client: ent.NewClient(ent.Driver(entsql.OpenDB(dialect.SQLite, db)))}, nil
}
func (s *Store) Close() error { return s.client.Close() }

func migrate(ctx context.Context, db *sql.DB) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, checksum TEXT NOT NULL)`); err != nil {
		return err
	}
	files, err := migrations.ReadDir("migrations")
	if err != nil {
		return err
	}
	known := map[string]bool{}
	for _, f := range files {
		known[f.Name()] = true
	}
	rows, err := tx.QueryContext(ctx, "SELECT version FROM schema_migrations")
	if err != nil {
		return err
	}
	for rows.Next() {
		var version string
		if err = rows.Scan(&version); err != nil {
			rows.Close()
			return err
		}
		if !known[version] {
			rows.Close()
			return fmt.Errorf("database migration %s is newer than this daemon", version)
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Name() < files[j].Name() })
	for _, f := range files {
		body, err := migrations.ReadFile("migrations/" + f.Name())
		if err != nil {
			return err
		}
		normalized := []byte(strings.ReplaceAll(string(body), "\r\n", "\n"))
		sum := sha256.Sum256(normalized)
		checksum := hex.EncodeToString(sum[:])
		var recorded string
		err = tx.QueryRowContext(ctx, "SELECT checksum FROM schema_migrations WHERE version=?", f.Name()).Scan(&recorded)
		if err == nil {
			if recorded != checksum {
				return fmt.Errorf("migration checksum mismatch: %s", f.Name())
			}
			continue
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		// Ent's initial DDL includes FK toggles; the connection already enforces them.
		ddl := strings.ReplaceAll(strings.ReplaceAll(string(body), "PRAGMA foreign_keys = off;", ""), "PRAGMA foreign_keys = on;", "")
		if _, err = tx.ExecContext(ctx, ddl); err != nil {
			return fmt.Errorf("migration %s: %w", f.Name(), err)
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO schema_migrations(version,checksum) VALUES (?,?)", f.Name(), checksum); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// SchemaFingerprint is stable across Windows/Unix checkouts and is used by the
// updater to require an identical migration contract for automatic rollback.
func SchemaFingerprint() string {
	files, err := migrations.ReadDir("migrations")
	if err != nil {
		panic(err)
	}
	hash := sha256.New()
	for _, file := range files {
		data, err := migrations.ReadFile("migrations/" + file.Name())
		if err != nil {
			panic(err)
		}
		normalized := strings.ReplaceAll(string(data), "\r\n", "\n")
		sum := sha256.Sum256([]byte(normalized))
		fmt.Fprintf(hash, "%s:%x\n", file.Name(), sum)
	}
	return hex.EncodeToString(hash.Sum(nil))
}
