package app

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// Field is the lossless wire description of a DuckDB column. BIGINT and
// DECIMAL values are returned as JSON strings by Query.
type Field struct {
	Name       string `json:"name"`
	DataType   string `json:"dataType"`
	Nullable   bool   `json:"nullable"`
	Default    any    `json:"default,omitempty"`
	PrimaryKey bool   `json:"primaryKey,omitempty"`
	Unique     bool   `json:"unique,omitempty"`
	Ordinal    int    `json:"ordinal"`
}

type Filter struct {
	Logic  string   `json:"logic,omitempty"`
	Rules  []Filter `json:"rules,omitempty"`
	Field  string   `json:"field,omitempty"`
	Op     string   `json:"op,omitempty"`
	Value  any      `json:"value,omitempty"`
	Values []any    `json:"values,omitempty"`
}

type Aggregate struct {
	Function string `json:"function"`
	Field    string `json:"field,omitempty"`
	Alias    string `json:"alias"`
}

type Order struct {
	Field     string `json:"field"`
	Direction string `json:"direction,omitempty"`
}

type QueryRequest struct {
	DatasetID  string      `json:"datasetId"`
	Table      string      `json:"table"`
	Fields     []string    `json:"fields,omitempty"`
	Filters    []Filter    `json:"filters,omitempty"`
	GroupBy    []string    `json:"groupBy,omitempty"`
	Aggregates []Aggregate `json:"aggregates,omitempty"`
	OrderBy    []Order     `json:"orderBy,omitempty"`
	Limit      int         `json:"limit,omitempty"`
	Offset     int         `json:"offset,omitempty"`
}

type QueryResult struct {
	Fields []Field          `json:"fields"`
	Rows   []map[string]any `json:"rows"`
	Total  int64            `json:"total"`
}

type DatasetSummary struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type RecordMutation struct {
	Action string         `json:"action"`
	Values map[string]any `json:"values,omitempty"`
	Filter *Filter        `json:"filter,omitempty"`
}

type MutationRequest struct {
	DatasetID      string           `json:"datasetId"`
	Table          string           `json:"table"`
	IdempotencyKey string           `json:"-"`
	Operations     []RecordMutation `json:"operations"`
}

type MutationResult struct {
	Inserted int64 `json:"inserted"`
	Updated  int64 `json:"updated"`
	Deleted  int64 `json:"deleted"`
}

type FieldDefinition struct {
	Name       string `json:"name"`
	DataType   string `json:"dataType"`
	Nullable   bool   `json:"nullable"`
	Default    any    `json:"default,omitempty"`
	PrimaryKey bool   `json:"primaryKey,omitempty"`
	Unique     bool   `json:"unique,omitempty"`
}

type SchemaMutationRequest struct {
	DatasetID      string            `json:"datasetId"`
	IdempotencyKey string            `json:"-"`
	Action         string            `json:"action"`
	Table          string            `json:"table"`
	Field          *FieldDefinition  `json:"field,omitempty"`
	Fields         []FieldDefinition `json:"fields,omitempty"`
	PrimaryKey     []string          `json:"primaryKey,omitempty"`
	UniqueKeys     [][]string        `json:"uniqueKeys,omitempty"`
	Column         string            `json:"column,omitempty"`
	NewName        string            `json:"newName,omitempty"`
	NewType        string            `json:"newType,omitempty"`
}

type SchemaMutationResult struct {
	Action string `json:"action"`
	Table  string `json:"table"`
}

type ControlledSQLRequest struct {
	DatasetID string         `json:"datasetId"`
	SQL       string         `json:"sql"`
	Params    map[string]any `json:"params,omitempty"`
}

type Policy struct {
	Operation  string
	AllColumns bool
	Columns    map[string]struct{}
	Row        *Filter
}

func validatePublicIdentifier(name, kind string) error {
	if name == "" || !utf8.ValidString(name) {
		return Error(400, "invalid_identifier", fmt.Sprintf("%s名称无效", kind))
	}
	for index, r := range []rune(name) {
		if index == 0 {
			if r != '_' && !unicode.IsLetter(r) {
				return Error(400, "invalid_identifier", fmt.Sprintf("%s名称无效", kind))
			}
		} else if r != '_' && !unicode.IsLetter(r) && !unicode.IsDigit(r) {
			return Error(400, "invalid_identifier", fmt.Sprintf("%s名称无效", kind))
		}
	}
	lower := strings.ToLower(name)
	if strings.HasPrefix(lower, "_rd_") || strings.HasPrefix(lower, "duckdb_") || strings.HasPrefix(lower, "sqlite_") || strings.HasPrefix(lower, "pragma_") || lower == "information_schema" || lower == "pg_catalog" || lower == "duckdb" {
		return Error(400, "reserved_identifier", fmt.Sprintf("%s不可访问", kind))
	}
	return nil
}

func quoteIdentifier(name string) string { return `"` + strings.ReplaceAll(name, `"`, `""`) + `"` }

func qualifiedTable(name string) string {
	return quoteIdentifier("vault") + "." + quoteIdentifier("main") + "." + quoteIdentifier(name)
}

func lockDatabase(ctx context.Context, database *Database) error {
	if database.Mu.TryLock() {
		return nil
	}
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			if database.Mu.TryLock() {
				return nil
			}
		}
	}
}

func normalizeFieldType(raw string) (string, error) {
	t := strings.ToUpper(strings.Join(strings.Fields(strings.TrimSpace(raw)), " "))
	aliases := map[string]string{"TEXT": "VARCHAR", "INT": "INTEGER", "BOOL": "BOOLEAN", "TIMESTAMPTZ": "TIMESTAMP WITH TIME ZONE"}
	if v, ok := aliases[t]; ok {
		t = v
	}
	switch t {
	case "BOOLEAN", "TINYINT", "SMALLINT", "INTEGER", "BIGINT", "HUGEINT",
		"UTINYINT", "USMALLINT", "UINTEGER", "UBIGINT", "UHUGEINT",
		"REAL", "FLOAT", "DOUBLE", "VARCHAR", "DATE", "TIME", "TIME WITH TIME ZONE", "TIMESTAMP",
		"TIMESTAMP_S", "TIMESTAMP_MS", "TIMESTAMP_NS", "TIMESTAMP WITH TIME ZONE", "UUID", "JSON":
		return t, nil
	}
	if strings.HasPrefix(t, "DECIMAL(") && strings.HasSuffix(t, ")") {
		parts := strings.Split(strings.TrimSuffix(strings.TrimPrefix(t, "DECIMAL("), ")"), ",")
		if len(parts) == 2 {
			precision, e1 := strconv.Atoi(strings.TrimSpace(parts[0]))
			scale, e2 := strconv.Atoi(strings.TrimSpace(parts[1]))
			if e1 == nil && e2 == nil && precision >= 1 && precision <= 38 && scale >= 0 && scale <= precision {
				return fmt.Sprintf("DECIMAL(%d,%d)", precision, scale), nil
			}
		}
	}
	return "", Error(400, "unsupported_type", "字段类型不在无损支持范围内")
}

func normalizeWireValue(v any, dataType string) any {
	if v == nil {
		return nil
	}
	t := strings.ToUpper(dataType)
	if b, ok := v.([]byte); ok {
		v = string(b)
	}
	if strings.Contains(t, "BIGINT") || strings.Contains(t, "HUGEINT") || strings.HasPrefix(t, "DECIMAL") {
		return fmt.Sprint(v)
	}
	if tm, ok := v.(time.Time); ok {
		if t == "DATE" {
			return tm.Format("2006-01-02")
		}
		if t == "TIME" {
			return tm.Format("15:04:05.999999999")
		}
		if t == "TIME WITH TIME ZONE" {
			return tm.Format("15:04:05.999999999Z07:00")
		}
		if strings.HasPrefix(t, "TIMESTAMP") && !strings.Contains(t, "TIME ZONE") {
			return tm.Format("2006-01-02T15:04:05.999999999")
		}
		return tm.UTC().Format(time.RFC3339Nano)
	}
	return v
}

func cloneFilter(f *Filter) *Filter {
	if f == nil {
		return nil
	}
	b, _ := json.Marshal(f)
	var out Filter
	_ = json.Unmarshal(b, &out)
	return &out
}

// DataService is the shared data boundary used by jobs and exports.
type DataService interface {
	Schema(context.Context, string, string) ([]Field, error)
	Query(context.Context, QueryRequest) (QueryResult, error)
	Mutate(context.Context, MutationRequest) (MutationResult, error)
}
