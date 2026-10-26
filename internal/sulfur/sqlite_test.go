package sulfur

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func sqliteTestDB(t *testing.T) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "a database #1.sqlite")
	if _, err := SQLiteLocal(context.Background(), SQLiteRequest{Path: p, Op: "create"}); err != nil {
		t.Fatal(err)
	}
	return p
}

func sqliteTestRun(t *testing.T, path, op, query string) SQLiteResult {
	t.Helper()
	r, err := SQLiteLocal(context.Background(), SQLiteRequest{Path: path, Op: op, SQL: query})
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func TestSQLiteCreateInspectAndQuery(t *testing.T) {
	p := sqliteTestDB(t)
	b, err := os.ReadFile(p)
	if err != nil || !bytes.HasPrefix(b, []byte("SQLite format 3\x00")) {
		t.Fatalf("not an initialized SQLite database: %v", err)
	}
	r := sqliteTestRun(t, p, "execute", `CREATE TABLE "odd table"(id INTEGER PRIMARY KEY, name TEXT); INSERT INTO "odd table"(name) VALUES ('first'), ('second'); CREATE VIEW names AS SELECT name FROM "odd table";`)
	if r.Changes != 2 {
		t.Fatalf("changes: %d", r.Changes)
	}
	r = sqliteTestRun(t, p, "schema", "")
	if len(r.Rows) != 2 || r.Rows[0][0] != "names" || r.Rows[1][0] != "odd table" {
		t.Fatalf("schema: %#v", r.Rows)
	}
	r = sqliteTestRun(t, p, "query", `SELECT id, name FROM "odd table" ORDER BY id`)
	if len(r.Rows) != 2 || r.Rows[1][0] != int64(2) || r.Rows[1][1] != "second" {
		t.Fatalf("rows: %#v", r.Rows)
	}
	if _, err = SQLiteLocal(context.Background(), SQLiteRequest{Path: p, Op: "create"}); err == nil {
		t.Fatal("creation overwrote an existing database")
	}
	if got := sqliteTestRun(t, p, "query", `SELECT count(*) FROM "odd table"`).Rows[0][0]; got != int64(2) {
		t.Fatalf("existing data changed: %v", got)
	}
}

func TestSQLiteRollbackAndReadOnly(t *testing.T) {
	p := sqliteTestDB(t)
	sqliteTestRun(t, p, "execute", "CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT)")
	for _, query := range []string{
		"INSERT INTO items VALUES (1,'first'); INSERT INTO missing VALUES (2);",
		"INSERT INTO items VALUES (1,'first'); COMMIT; INSERT INTO items VALUES (2,'escaped');",
		"INSERT INTO items VALUES (1,'first'); SAVEPOINT escape;",
	} {
		if _, err := SQLiteLocal(context.Background(), SQLiteRequest{Path: p, Op: "execute", SQL: query}); err == nil {
			t.Fatalf("expected rollback: %s", query)
		}
		if got := sqliteTestRun(t, p, "query", "SELECT count(*) FROM items").Rows[0][0]; got != int64(0) {
			t.Fatalf("partial transaction persisted: %v", got)
		}
	}
	if _, err := SQLiteLocal(context.Background(), SQLiteRequest{Path: p, Op: "query", SQL: "INSERT INTO items VALUES (1,'write')"}); err == nil {
		t.Fatal("query modified database")
	}
}

func TestSQLiteDoesNotCreateImplicitlyOrAccessOtherFiles(t *testing.T) {
	p := sqliteTestDB(t)
	missing := filepath.Join(filepath.Dir(p), "missing.sqlite")
	if _, err := SQLiteLocal(context.Background(), SQLiteRequest{Path: missing, Op: "query", SQL: "SELECT 1"}); err == nil {
		t.Fatal("missing database opened")
	}
	if _, err := os.Stat(missing); !os.IsNotExist(err) {
		t.Fatalf("missing database was created: %v", err)
	}
	quoted := "'" + strings.ReplaceAll(filepath.ToSlash(missing), "'", "''") + "'"
	for _, query := range []string{"ATTACH DATABASE " + quoted + " AS other", "VACUUM INTO " + quoted, "SELECT load_extension('missing')", "PRAGMA temp_store_directory='.'"} {
		if _, err := SQLiteLocal(context.Background(), SQLiteRequest{Path: p, Op: "query", SQL: query}); err == nil {
			t.Fatalf("unexpected external access: %s", query)
		}
	}
	if _, err := os.Stat(missing); !os.IsNotExist(err) {
		t.Fatalf("external database was created: %v", err)
	}
}

func TestSQLiteBoundedResultsAndExactIntegers(t *testing.T) {
	p := sqliteTestDB(t)
	r, err := SQLiteLocal(context.Background(), SQLiteRequest{Path: p, Op: "query", Limit: 3, SQL: "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10) SELECT x FROM n"})
	if err != nil || !r.Truncated || len(r.Rows) != 3 {
		t.Fatalf("limit: %#v, %v", r, err)
	}
	r = sqliteTestRun(t, p, "query", "SELECT 9223372036854775807, NULL, x'0102', zeroblob(128)")
	if r.Rows[0][0] != "9223372036854775807" || r.Rows[0][1] != nil || r.Rows[0][2] != "BLOB (2 bytes): 0102" || !strings.HasPrefix(r.Rows[0][3].(string), "BLOB (128 bytes): ") {
		t.Fatalf("cell representations: %#v", r.Rows)
	}
	if _, err = SQLiteLocal(context.Background(), SQLiteRequest{Path: p, Op: "query", SQL: "SELECT zeroblob(1000000000)"}); err == nil {
		t.Fatal("unbounded SQLite value accepted")
	}
}

func TestSQLiteCancellationAndHelper(t *testing.T) {
	p := sqliteTestDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), time.Millisecond)
	defer cancel()
	_, err := SQLiteLocal(ctx, SQLiteRequest{Path: p, Op: "query", SQL: "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n"})
	if err == nil {
		t.Fatal("unbounded query ignored cancellation")
	}
	request, _ := json.Marshal(SQLiteRequest{Path: p, Op: "query", SQL: "SELECT 42"})
	var out, stderr bytes.Buffer
	if status := SQLiteMain(bytes.NewReader(request), &out, &stderr); status != 0 {
		t.Fatalf("helper failed: %d, %s", status, stderr.String())
	}
	var r SQLiteResult
	if err = json.Unmarshal(out.Bytes(), &r); err != nil || len(r.Rows) != 1 || r.Rows[0][0] != float64(42) {
		t.Fatalf("helper response: %s, %v", out.String(), err)
	}
}
