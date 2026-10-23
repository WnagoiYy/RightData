package server_test

import (
	"strings"
	"testing"

	"server/app"
)

func TestParseControlledSelectUsesNamedParameters(t *testing.T) {
	req, err := app.ParseControlledSelect(
		`SELECT region, SUM(amount) AS total FROM sales WHERE region = :region AND amount >= :minimum GROUP BY region ORDER BY total DESC LIMIT 20`,
		map[string]any{"region": "north", "minimum": "10.00"},
		"sales-db",
	)
	if err != nil {
		t.Fatal(err)
	}
	if req.DatasetID != "sales-db" || req.Table != "sales" || len(req.Filters) != 1 || len(req.Aggregates) != 1 {
		t.Fatalf("unexpected parsed request: %#v", req)
	}
}

func TestParseControlledSelectRejectsUnsafeSQL(t *testing.T) {
	tests := map[string]string{
		"multiple statements": `SELECT id FROM sales; DROP TABLE sales`,
		"line comment":        "SELECT id FROM sales -- hidden operation",
		"block comment":       `SELECT id FROM sales /* hidden operation */`,
		"join":                `SELECT id FROM sales JOIN secrets ON sales.id = secrets.id`,
		"subquery":            `SELECT id FROM (SELECT id FROM sales) nested`,
		"union":               `SELECT id FROM sales UNION SELECT id FROM secrets`,
		"cte":                 `WITH hidden AS (SELECT * FROM secrets) SELECT * FROM hidden`,
		"file function":       `SELECT read_csv('secret.csv') AS value FROM sales`,
		"unknown function":    `SELECT md5(id) AS value FROM sales`,
	}
	for name, statement := range tests {
		t.Run(name, func(t *testing.T) {
			if _, err := app.ParseControlledSelect(statement, nil, "sales-db"); err == nil {
				t.Fatalf("unsafe SQL was accepted: %s", statement)
			}
		})
	}
}

func TestParseControlledSelectRejectsMissingParameter(t *testing.T) {
	_, err := app.ParseControlledSelect(`SELECT id FROM sales WHERE region = :region`, nil, "sales-db")
	requireAPIError(t, err, 400, "missing_parameter")
}

func TestParseControlledSelectRejectsResourceExhaustion(t *testing.T) {
	t.Run("input bytes", func(t *testing.T) {
		statement := `SELECT id FROM sales WHERE region = '` + strings.Repeat("x", 64<<10) + `'`
		_, err := app.ParseControlledSelect(statement, nil, "sales-db")
		requireAPIError(t, err, 413, "sql_too_large")
	})

	t.Run("token count", func(t *testing.T) {
		statement := `SELECT ` + strings.Repeat("id,", 4096) + `id FROM sales`
		_, err := app.ParseControlledSelect(statement, nil, "sales-db")
		requireAPIError(t, err, 400, "sql_too_complex")
	})

	t.Run("parenthesis depth", func(t *testing.T) {
		statement := `SELECT id FROM sales WHERE ` + strings.Repeat("(", 33) + `id = 1` + strings.Repeat(")", 33)
		_, err := app.ParseControlledSelect(statement, nil, "sales-db")
		requireAPIError(t, err, 400, "sql_too_complex")
	})
}
