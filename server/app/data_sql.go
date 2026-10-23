package app

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"unicode"
)

// The controlled SQL endpoint accepts one single-table SELECT with column
// projection, the six supported aggregates, AND/OR predicates, GROUP BY,
// ORDER BY, LIMIT and OFFSET. It is parsed into QueryRequest; submitted SQL is
// never sent to DuckDB. Joins, subqueries, functions in predicates, comments,
// CTEs, window expressions and multiple statements are intentionally rejected.
func (a *App) QueryControlledSQL(ctx context.Context, req ControlledSQLRequest) (QueryResult, error) {
	if _, err := Require(ctx, "sql.execute"); err != nil {
		return QueryResult{}, err
	}
	query, err := ParseControlledSelect(req.SQL, req.Params, req.DatasetID)
	if err != nil {
		return QueryResult{}, err
	}
	return a.Query(WithQueryKind(ctx, "controlled_sql"), query)
}

type sqlToken struct {
	kind, text string
	value      any
}

const (
	maxControlledSQLBytes      = 64 << 10
	maxControlledSQLTokens     = 4096
	maxControlledSQLParenDepth = 32
)

func lexControlledSQL(input string) ([]sqlToken, error) {
	if len(input) > maxControlledSQLBytes {
		return nil, Error(413, "sql_too_large", "受控 SQL 不能超过 64 KiB")
	}
	var tokens []sqlToken
	parenDepth := 0
	emit := func(token sqlToken) error {
		if len(tokens) >= maxControlledSQLTokens {
			return Error(400, "sql_too_complex", "受控 SQL 词法单元过多")
		}
		tokens = append(tokens, token)
		return nil
	}
	for i := 0; i < len(input); {
		r := rune(input[i])
		if unicode.IsSpace(r) {
			i++
			continue
		}
		if input[i] == ';' {
			return nil, Error(400, "unsupported_sql", "仅支持单条 SELECT，不允许分号")
		}
		if i+1 < len(input) && ((input[i] == '-' && input[i+1] == '-') || (input[i] == '/' && input[i+1] == '*')) {
			return nil, Error(400, "unsupported_sql", "受控 SQL 不支持注释")
		}
		if isIdentStart(input[i]) {
			start := i
			i++
			for i < len(input) && isIdentPart(input[i]) {
				i++
			}
			if err := emit(sqlToken{kind: "ident", text: input[start:i]}); err != nil {
				return nil, err
			}
			continue
		}
		if input[i] == '"' {
			i++
			var b strings.Builder
			closed := false
			for i < len(input) {
				if input[i] == '"' {
					if i+1 < len(input) && input[i+1] == '"' {
						b.WriteByte('"')
						i += 2
						continue
					}
					i++
					closed = true
					break
				}
				b.WriteByte(input[i])
				i++
			}
			if !closed {
				return nil, Error(400, "invalid_sql", "标识符引号未闭合")
			}
			if err := emit(sqlToken{kind: "ident", text: b.String()}); err != nil {
				return nil, err
			}
			continue
		}
		if input[i] == '\'' {
			i++
			var b strings.Builder
			closed := false
			for i < len(input) {
				if input[i] == '\'' {
					if i+1 < len(input) && input[i+1] == '\'' {
						b.WriteByte('\'')
						i += 2
						continue
					}
					i++
					closed = true
					break
				}
				b.WriteByte(input[i])
				i++
			}
			if !closed {
				return nil, Error(400, "invalid_sql", "字符串引号未闭合")
			}
			if err := emit(sqlToken{kind: "value", value: b.String()}); err != nil {
				return nil, err
			}
			continue
		}
		if input[i] == ':' {
			start := i + 1
			i = start
			if i >= len(input) || !isIdentStart(input[i]) {
				return nil, Error(400, "invalid_sql", "参数名无效")
			}
			i++
			for i < len(input) && isIdentPart(input[i]) {
				i++
			}
			if err := emit(sqlToken{kind: "param", text: input[start:i]}); err != nil {
				return nil, err
			}
			continue
		}
		if (input[i] >= '0' && input[i] <= '9') || (input[i] == '-' && i+1 < len(input) && input[i+1] >= '0' && input[i+1] <= '9') {
			start := i
			i++
			for i < len(input) && input[i] >= '0' && input[i] <= '9' {
				i++
			}
			if i < len(input) && input[i] == '.' {
				i++
				for i < len(input) && input[i] >= '0' && input[i] <= '9' {
					i++
				}
			}
			raw := input[start:i]
			if strings.Contains(raw, ".") {
				v, e := strconv.ParseFloat(raw, 64)
				if e != nil {
					return nil, Error(400, "invalid_sql", "数值格式无效")
				}
				if err := emit(sqlToken{kind: "value", value: v}); err != nil {
					return nil, err
				}
			} else {
				v, e := strconv.ParseInt(raw, 10, 64)
				if e != nil {
					if err := emit(sqlToken{kind: "value", value: raw}); err != nil {
						return nil, err
					}
				} else {
					if err := emit(sqlToken{kind: "value", value: v}); err != nil {
						return nil, err
					}
				}
			}
			continue
		}
		if strings.ContainsRune("(),*", r) {
			if input[i] == '(' {
				parenDepth++
				if parenDepth > maxControlledSQLParenDepth {
					return nil, Error(400, "sql_too_complex", "受控 SQL 括号嵌套过深")
				}
			} else if input[i] == ')' && parenDepth > 0 {
				parenDepth--
			}
			if err := emit(sqlToken{kind: "symbol", text: string(input[i])}); err != nil {
				return nil, err
			}
			i++
			continue
		}
		if strings.ContainsRune("=<>!", r) {
			start := i
			i++
			if i < len(input) && ((input[start] == '<' && (input[i] == '=' || input[i] == '>')) || (input[start] == '>' && input[i] == '=') || (input[start] == '!' && input[i] == '=')) {
				i++
			}
			op := input[start:i]
			if op == "!=" {
				op = "<>"
			}
			if err := emit(sqlToken{kind: "op", text: op}); err != nil {
				return nil, err
			}
			continue
		}
		return nil, Error(400, "unsupported_sql", fmt.Sprintf("受控 SQL 不支持字符 %q", input[i]))
	}
	tokens = append(tokens, sqlToken{kind: "eof"})
	return tokens, nil
}

func isIdentStart(b byte) bool { return b == '_' || (b >= 'A' && b <= 'Z') || (b >= 'a' && b <= 'z') }
func isIdentPart(b byte) bool  { return isIdentStart(b) || (b >= '0' && b <= '9') }

type controlledParser struct {
	tokens []sqlToken
	pos    int
	params map[string]any
	req    QueryRequest
}

func (p *controlledParser) peek() sqlToken { return p.tokens[p.pos] }
func (p *controlledParser) take() sqlToken {
	t := p.peek()
	if t.kind != "eof" {
		p.pos++
	}
	return t
}
func (p *controlledParser) keyword(word string) bool {
	t := p.peek()
	return t.kind == "ident" && strings.EqualFold(t.text, word)
}
func (p *controlledParser) acceptKeyword(word string) bool {
	if p.keyword(word) {
		p.take()
		return true
	}
	return false
}
func (p *controlledParser) expectKeyword(word string) error {
	if !p.acceptKeyword(word) {
		return Error(400, "invalid_sql", "缺少 "+strings.ToUpper(word))
	}
	return nil
}
func (p *controlledParser) acceptSymbol(s string) bool {
	t := p.peek()
	if t.kind == "symbol" && t.text == s {
		p.take()
		return true
	}
	return false
}
func (p *controlledParser) expectSymbol(s string) error {
	if !p.acceptSymbol(s) {
		return Error(400, "invalid_sql", "缺少 "+s)
	}
	return nil
}
func (p *controlledParser) identifier() (string, error) {
	t := p.take()
	if t.kind != "ident" {
		return "", Error(400, "invalid_sql", "此处需要字段或表名")
	}
	if err := validatePublicIdentifier(t.text, "标识符"); err != nil {
		return "", err
	}
	return t.text, nil
}

// ParseControlledSelect parses the documented SQL subset into the same safe
// structured query used by reports and dashboards.
func ParseControlledSelect(statement string, params map[string]any, datasetID string) (QueryRequest, error) {
	tokens, err := lexControlledSQL(statement)
	if err != nil {
		return QueryRequest{}, err
	}
	p := &controlledParser{tokens: tokens, params: params, req: QueryRequest{DatasetID: datasetID}}
	if err = p.expectKeyword("select"); err != nil {
		return QueryRequest{}, err
	}
	star := false
	for {
		if p.acceptSymbol("*") {
			if len(p.req.Fields) > 0 || len(p.req.Aggregates) > 0 {
				return QueryRequest{}, Error(400, "invalid_sql", "* 不能与其他查询字段混用")
			}
			star = true
		} else {
			name, err := p.identifier()
			if err != nil {
				return QueryRequest{}, err
			}
			if p.acceptSymbol("(") {
				fn := strings.ToLower(name)
				if fn != "sum" && fn != "count" && fn != "avg" && fn != "min" && fn != "max" {
					return QueryRequest{}, Error(400, "unsupported_sql", "不支持的聚合函数")
				}
				target := ""
				distinct := false
				if p.acceptKeyword("distinct") {
					if fn != "count" {
						return QueryRequest{}, Error(400, "unsupported_sql", "DISTINCT 仅支持 COUNT")
					}
					distinct = true
				}
				if p.acceptSymbol("*") {
					target = "*"
				} else {
					target, err = p.identifier()
					if err != nil {
						return QueryRequest{}, err
					}
				}
				if err = p.expectSymbol(")"); err != nil {
					return QueryRequest{}, err
				}
				if err = p.expectKeyword("as"); err != nil {
					return QueryRequest{}, Error(400, "invalid_sql", "聚合结果必须使用 AS 指定别名")
				}
				alias, err := p.identifier()
				if err != nil {
					return QueryRequest{}, err
				}
				if distinct {
					fn = "count_distinct"
				}
				p.req.Aggregates = append(p.req.Aggregates, Aggregate{Function: fn, Field: target, Alias: alias})
			} else {
				if star {
					return QueryRequest{}, Error(400, "invalid_sql", "* 不能与其他查询字段混用")
				}
				if p.acceptKeyword("as") {
					return QueryRequest{}, Error(400, "unsupported_sql", "普通字段暂不支持别名")
				}
				p.req.Fields = append(p.req.Fields, name)
			}
		}
		if !p.acceptSymbol(",") {
			break
		}
	}
	if err = p.expectKeyword("from"); err != nil {
		return QueryRequest{}, err
	}
	p.req.Table, err = p.identifier()
	if err != nil {
		return QueryRequest{}, err
	}
	if p.acceptKeyword("where") {
		filter, err := p.parseOr()
		if err != nil {
			return QueryRequest{}, err
		}
		p.req.Filters = []Filter{filter}
	}
	if p.acceptKeyword("group") {
		if err = p.expectKeyword("by"); err != nil {
			return QueryRequest{}, err
		}
		for {
			v, e := p.identifier()
			if e != nil {
				return QueryRequest{}, e
			}
			p.req.GroupBy = append(p.req.GroupBy, v)
			if !p.acceptSymbol(",") {
				break
			}
		}
	}
	if p.acceptKeyword("order") {
		if err = p.expectKeyword("by"); err != nil {
			return QueryRequest{}, err
		}
		for {
			v, e := p.identifier()
			if e != nil {
				return QueryRequest{}, e
			}
			direction := "ASC"
			if p.keyword("asc") || p.keyword("desc") {
				direction = strings.ToUpper(p.take().text)
			}
			p.req.OrderBy = append(p.req.OrderBy, Order{Field: v, Direction: direction})
			if !p.acceptSymbol(",") {
				break
			}
		}
	}
	if p.acceptKeyword("limit") {
		v, e := p.nonNegativeInt()
		if e != nil {
			return QueryRequest{}, e
		}
		p.req.Limit = v
	}
	if p.acceptKeyword("offset") {
		v, e := p.nonNegativeInt()
		if e != nil {
			return QueryRequest{}, e
		}
		p.req.Offset = v
	}
	if p.peek().kind != "eof" {
		return QueryRequest{}, Error(400, "unsupported_sql", "受控 SQL 包含不支持的语法")
	}
	return p.req, nil
}

func (p *controlledParser) nonNegativeInt() (int, error) {
	t := p.take()
	if t.kind != "value" {
		return 0, Error(400, "invalid_sql", "LIMIT/OFFSET 必须是非负整数")
	}
	v, ok := t.value.(int64)
	if !ok || v < 0 || v > int64(^uint(0)>>1) {
		return 0, Error(400, "invalid_sql", "LIMIT/OFFSET 必须是非负整数")
	}
	return int(v), nil
}

func (p *controlledParser) parseOr() (Filter, error) {
	left, err := p.parseAnd()
	if err != nil {
		return Filter{}, err
	}
	rules := []Filter{left}
	for p.acceptKeyword("or") {
		right, e := p.parseAnd()
		if e != nil {
			return Filter{}, e
		}
		rules = append(rules, right)
	}
	if len(rules) == 1 {
		return left, nil
	}
	return Filter{Logic: "or", Rules: rules}, nil
}
func (p *controlledParser) parseAnd() (Filter, error) {
	left, err := p.parseTerm()
	if err != nil {
		return Filter{}, err
	}
	rules := []Filter{left}
	for p.acceptKeyword("and") {
		right, e := p.parseTerm()
		if e != nil {
			return Filter{}, e
		}
		rules = append(rules, right)
	}
	if len(rules) == 1 {
		return left, nil
	}
	return Filter{Logic: "and", Rules: rules}, nil
}
func (p *controlledParser) parseTerm() (Filter, error) {
	if p.acceptSymbol("(") {
		f, err := p.parseOr()
		if err != nil {
			return Filter{}, err
		}
		if err = p.expectSymbol(")"); err != nil {
			return Filter{}, err
		}
		return f, nil
	}
	return p.parsePredicate()
}

func (p *controlledParser) parsePredicate() (Filter, error) {
	field, err := p.identifier()
	if err != nil {
		return Filter{}, err
	}
	if p.acceptKeyword("is") {
		not := p.acceptKeyword("not")
		if !p.acceptKeyword("null") {
			return Filter{}, Error(400, "unsupported_sql", "IS 仅支持 NULL")
		}
		op := "is_null"
		if not {
			op = "is_not_null"
		}
		return Filter{Field: field, Op: op}, nil
	}
	if p.acceptKeyword("between") {
		first, e := p.value()
		if e != nil {
			return Filter{}, e
		}
		if e = p.expectKeyword("and"); e != nil {
			return Filter{}, e
		}
		second, e := p.value()
		if e != nil {
			return Filter{}, e
		}
		return Filter{Field: field, Op: "between", Values: []any{first, second}}, nil
	}
	not := p.acceptKeyword("not")
	if p.acceptKeyword("in") {
		if err = p.expectSymbol("("); err != nil {
			return Filter{}, err
		}
		var values []any
		for {
			v, e := p.value()
			if e != nil {
				return Filter{}, e
			}
			values = append(values, v)
			if !p.acceptSymbol(",") {
				break
			}
		}
		if err = p.expectSymbol(")"); err != nil {
			return Filter{}, err
		}
		op := "in"
		if not {
			op = "not_in"
		}
		return Filter{Field: field, Op: op, Values: values}, nil
	}
	if not {
		return Filter{}, Error(400, "unsupported_sql", "NOT 仅支持 NOT IN")
	}
	t := p.take()
	if t.kind != "op" {
		return Filter{}, Error(400, "invalid_sql", "筛选条件缺少比较操作符")
	}
	ops := map[string]string{"=": "eq", "<>": "ne", "<": "lt", "<=": "lte", ">": "gt", ">=": "gte"}
	op, ok := ops[t.text]
	if !ok {
		return Filter{}, Error(400, "unsupported_sql", "不支持的比较操作符")
	}
	value, e := p.value()
	if e != nil {
		return Filter{}, e
	}
	return Filter{Field: field, Op: op, Value: value}, nil
}

func (p *controlledParser) value() (any, error) {
	t := p.take()
	if t.kind == "value" {
		return t.value, nil
	}
	if t.kind == "param" {
		v, ok := p.params[t.text]
		if !ok {
			return nil, Error(400, "missing_parameter", "缺少 SQL 参数: "+t.text)
		}
		return v, nil
	}
	if t.kind == "ident" {
		if strings.EqualFold(t.text, "true") {
			return true, nil
		}
		if strings.EqualFold(t.text, "false") {
			return false, nil
		}
		if strings.EqualFold(t.text, "null") {
			return nil, nil
		}
	}
	return nil, Error(400, "invalid_sql", "筛选值无效")
}
