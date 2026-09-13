// Command migrate generates reviewed SQL from the Ent schema. Run from the module root.
package main

import (
	"context"
	"database/sql"
	"flag"
	"log"
	"os"

	"entgo.io/ent/dialect"
	entsql "entgo.io/ent/dialect/sql"
	"github.com/Zxilly/bifurcation/services/daemon/internal/state/ent"
	_ "modernc.org/sqlite"
)

func main() {
	database := flag.String("database", "file:migration?mode=memory&cache=shared&_pragma=foreign_keys(1)", "database copy to inspect for SQL delta")
	flag.Parse()
	db, err := sql.Open("sqlite", *database)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	if _, err := db.Exec("PRAGMA foreign_keys=ON"); err != nil {
		log.Fatal(err)
	}
	client := ent.NewClient(ent.Driver(entsql.OpenDB(dialect.SQLite, db)))
	if err := client.Schema.WriteTo(context.Background(), os.Stdout); err != nil {
		log.Fatal(err)
	}
}
