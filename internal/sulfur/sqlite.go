package sulfur

// SQLite runs in the desktop process, or in a short-lived helper under the
// project's SSH login. Opening a database never creates it implicitly.
import (
	"bytes"
	"context"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/pmghartman/phosphorus/internal/code"
	"modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"
)

type SQLiteRequest struct {
	Path  string `json:"path"`
	Op    string `json:"op"`
	SQL   string `json:"sql"`
	Limit int    `json:"limit,omitempty"`
}

type SQLiteResult struct {
	Columns   []string `json:"columns"`
	Rows      [][]any  `json:"rows"`
	Truncated bool     `json:"truncated,omitempty"`
	Changes   int64    `json:"changes,omitempty"`
	Error     string   `json:"error,omitempty"`
}

const sqliteResultBytes = 8 << 20

func SQLiteLocal(ctx context.Context, p SQLiteRequest) (SQLiteResult, error) {
	r := SQLiteResult{Columns: []string{}, Rows: [][]any{}}
	if !filepath.IsAbs(p.Path) || strings.ContainsRune(p.Path, 0) {
		return r, errors.New("choose a full path to a database")
	}
	if p.Op != "create" && p.Op != "schema" && p.Op != "query" && p.Op != "execute" {
		return r, errors.New("unknown SQLite operation")
	}
	if len(p.SQL) > 1<<20 {
		return r, errors.New("SQL exceeds 1 MiB")
	}
	if (p.Op == "query" || p.Op == "execute") && strings.TrimSpace(p.SQL) == "" {
		return r, errors.New("enter SQL first")
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	created := false
	if p.Op == "create" {
		f, err := os.OpenFile(p.Path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o600)
		if err != nil {
			return r, err
		}
		if err = f.Close(); err != nil {
			os.Remove(p.Path)
			return r, err
		}
		// Only remove our exclusively created file if initialization fails.
		defer func() {
			if !created {
				os.Remove(p.Path)
			}
		}()
	} else if st, err := os.Stat(p.Path); err != nil {
		return r, err
	} else if !st.Mode().IsRegular() {
		return r, errors.New("choose a database file")
	}
	mode := "ro"
	if p.Op == "create" || p.Op == "execute" {
		mode = "rw"
	}
	path := filepath.ToSlash(p.Path)
	if !strings.HasPrefix(path, "/") {
		path = "/" + path // file:///C:/... on Windows, escaped by net/url.
	}
	u := url.URL{Scheme: "file", Path: path}
	q := url.Values{"mode": {mode}, "_pragma": {"busy_timeout(2000)", "foreign_keys(1)", "trusted_schema(0)"}}
	u.RawQuery = q.Encode()
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return r, err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	conn, err := db.Conn(ctx)
	if err != nil {
		return r, err
	}
	defer conn.Close()
	// Bound individual SQLite allocations before SQL can request a giant value.
	for id, value := range map[int]int{sqlite3.SQLITE_LIMIT_LENGTH: 16 << 20, sqlite3.SQLITE_LIMIT_SQL_LENGTH: 1 << 20, sqlite3.SQLITE_LIMIT_COLUMN: 512} {
		if _, err = sqlite.Limit(conn, id, value); err != nil {
			return r, err
		}
	}
	var guardTx atomic.Bool
	err = conn.Raw(func(c any) error {
		a, ok := c.(sqlite.AuthorizerRegisterer)
		if !ok {
			return errors.New("SQLite authorizer unavailable")
		}
		return a.RegisterAuthorizer(func(action sqlite.AuthorizerActionCode, a, b, _, _ string) sqlite.AuthorizerReturnCode {
			switch action {
			case sqlite.AuthAttach:
				if a != "" { // VACUUM uses a temporary, unnamed database.
					return sqlite.AuthorizerDeny
				}
			case sqlite.AuthFunction:
				switch strings.ToLower(b) {
				case "load_extension", "readfile", "writefile":
					return sqlite.AuthorizerDeny
				}
			case sqlite.AuthPragma:
				switch strings.ToLower(a) {
				case "temp_store_directory", "data_store_directory":
					return sqlite.AuthorizerDeny
				}
			case sqlite.AuthTransaction, sqlite.AuthSavepoint:
				if guardTx.Load() {
					return sqlite.AuthorizerDeny
				}
			}
			return sqlite.AuthorizerOK
		})
	})
	if err != nil {
		return r, err
	}
	switch p.Op {
	case "create":
		_, err = conn.ExecContext(ctx, "VACUUM")
		created = err == nil
		return r, err
	case "execute":
		tx, err := conn.BeginTx(ctx, nil)
		if err != nil {
			return r, err
		}
		defer tx.Rollback()
		guardTx.Store(true)
		_, err = tx.ExecContext(ctx, p.SQL)
		guardTx.Store(false)
		if err != nil {
			return r, err
		}
		if err = tx.QueryRowContext(ctx, "SELECT total_changes()").Scan(&r.Changes); err != nil {
			return r, err
		}
		return r, tx.Commit()
	case "schema":
		p.SQL = "SELECT name, type, sql FROM sqlite_schema WHERE type IN ('table','view') AND name NOT GLOB 'sqlite_*' ORDER BY name"
	}
	if p.Limit <= 0 || p.Limit > 1000 {
		p.Limit = 200
	}
	rows, err := conn.QueryContext(ctx, p.SQL)
	if err != nil {
		return r, err
	}
	defer rows.Close()
	r.Columns, err = rows.Columns()
	if err != nil {
		return r, err
	}
	if len(r.Columns) > 512 {
		return r, errors.New("query has more than 512 columns")
	}
	size := 0
	for rows.Next() {
		if len(r.Rows) == p.Limit {
			r.Truncated = true
			break
		}
		values, ptrs := make([]any, len(r.Columns)), make([]any, len(r.Columns))
		for i := range values {
			ptrs[i] = &values[i]
		}
		if err = rows.Scan(ptrs...); err != nil {
			return r, err
		}
		for i, v := range values {
			values[i] = sqliteCell(v)
		}
		b, err := json.Marshal(values)
		if err != nil {
			return r, err
		}
		if size+len(b) > sqliteResultBytes {
			r.Truncated = true
			break
		}
		size += len(b)
		r.Rows = append(r.Rows, values)
	}
	return r, rows.Err()
}

func sqliteCell(v any) any {
	switch x := v.(type) {
	case []byte:
		n := len(x)
		if len(x) > 64 {
			x = x[:64]
		}
		return fmt.Sprintf("BLOB (%d bytes): %s", n, hex.EncodeToString(x))
	case string:
		if len(x) > 65536 {
			return strings.ToValidUTF8(x[:65536], "�") + "… [truncated]"
		}
	case int64:
		if x > 9007199254740991 || x < -9007199254740991 {
			return strconv.FormatInt(x, 10)
		}
	case float64:
		if math.IsInf(x, 0) || math.IsNaN(x) {
			return fmt.Sprint(x)
		}
	}
	return v
}

// SQLiteMain is the mesh host helper. SQL and paths travel over stdin, never
// through shell arguments. Its database operations use the SSH user's identity.
func SQLiteMain(in io.Reader, out, stderr io.Writer) int {
	var p SQLiteRequest
	if err := json.NewDecoder(io.LimitReader(in, (1<<20)+4096)).Decode(&p); err != nil {
		fmt.Fprintln(stderr, "invalid SQLite request")
		return 2
	}
	r, err := SQLiteLocal(context.Background(), p)
	if err != nil {
		r.Error = err.Error()
	}
	if err = json.NewEncoder(out).Encode(r); err != nil {
		return 1
	}
	return 0
}

func SQLiteRemote(ctx context.Context, host string, creds code.Creds, p SQLiteRequest) (SQLiteResult, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cl, err := code.Dial(host, creds)
	if err != nil {
		return SQLiteResult{}, err
	}
	defer cl.Close()
	win, err := isWindows(cl)
	if err != nil {
		return SQLiteResult{}, err
	}
	ss, err := cl.NewSession()
	if err != nil {
		return SQLiteResult{}, err
	}
	defer ss.Close()
	arg, _ := json.Marshal(p)
	ss.Stdin = bytes.NewReader(arg)
	var out, errb bytes.Buffer
	ss.Stdout, ss.Stderr = &out, &errb
	line := "phosphorus sulfur-sqlite"
	if !win {
		line = "sh -c " + code.Quote(posixPath+line)
	}
	done := make(chan error, 1)
	go func() { done <- ss.Run(line) }()
	select {
	case err = <-done:
	case <-ctx.Done():
		cl.Close()
		<-done
		return SQLiteResult{}, ctx.Err()
	}
	if err != nil {
		return SQLiteResult{}, fmt.Errorf("SQLite helper failed; update Phosphorus on %s: %w: %s", host, err, strings.TrimSpace(errb.String()))
	}
	var r SQLiteResult
	if err = json.Unmarshal(out.Bytes(), &r); err != nil {
		return r, errors.New("invalid response from the SQLite host")
	}
	if r.Error != "" {
		return r, errors.New(r.Error)
	}
	return r, nil
}
