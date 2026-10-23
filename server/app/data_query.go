package app

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"
	"time"
)

func (a *App) rawSchema(ctx context.Context, database *Database, table string) ([]Field, error) {
	if err := validatePublicIdentifier(table, "表"); err != nil {
		return nil, err
	}
	rows, err := database.DB.QueryContext(ctx, `SELECT c.column_name, c.data_type, c.is_nullable, c.column_default, c.ordinal_position FROM information_schema.columns c JOIN information_schema.tables t ON t.table_catalog=c.table_catalog AND t.table_schema=c.table_schema AND t.table_name=c.table_name WHERE c.table_catalog='vault' AND c.table_schema='main' AND c.table_name=? AND t.table_type='BASE TABLE' ORDER BY c.ordinal_position`, table)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var fields []Field
	for rows.Next() {
		var f Field
		var nullable string
		var defaultValue sql.NullString
		if err := rows.Scan(&f.Name, &f.DataType, &nullable, &defaultValue, &f.Ordinal); err != nil {
			return nil, err
		}
		normalized, err := normalizeFieldType(f.DataType)
		if err != nil {
			return nil, err
		}
		f.DataType = normalized
		f.Nullable = strings.EqualFold(nullable, "YES")
		if defaultValue.Valid {
			f.Default = defaultValue.String
		}
		fields = append(fields, f)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if len(fields) == 0 {
		return nil, Error(404, "table_not_found", "数据表不存在")
	}
	constraints, err := database.DB.QueryContext(ctx, `SELECT tc.constraint_type,kcu.column_name FROM information_schema.table_constraints tc JOIN information_schema.key_column_usage kcu ON kcu.constraint_catalog=tc.constraint_catalog AND kcu.constraint_schema=tc.constraint_schema AND kcu.constraint_name=tc.constraint_name WHERE tc.constraint_catalog='vault' AND tc.constraint_schema='main' AND tc.table_name=? AND tc.constraint_type IN ('PRIMARY KEY','UNIQUE')`, table)
	if err != nil {
		return nil, err
	}
	defer constraints.Close()
	indexes := map[string]int{}
	for i, f := range fields {
		indexes[strings.ToLower(f.Name)] = i
	}
	for constraints.Next() {
		var kind, column string
		if err := constraints.Scan(&kind, &column); err != nil {
			return nil, err
		}
		if i, ok := indexes[strings.ToLower(column)]; ok {
			if kind == "PRIMARY KEY" {
				fields[i].PrimaryKey = true
			}
			if kind == "UNIQUE" {
				fields[i].Unique = true
			}
		}
	}
	if err := constraints.Err(); err != nil {
		return nil, err
	}
	return fields, nil
}

func fieldMap(fields []Field) map[string]Field {
	out := make(map[string]Field, len(fields))
	for _, f := range fields {
		out[strings.ToLower(f.Name)] = f
	}
	return out
}

// ListDatasets returns the minimal client-facing registry. Storage paths,
// passwords and ownership remain confined to database operations APIs.
func (a *App) ListDatasets(ctx context.Context) ([]DatasetSummary, error) {
	u, err := Require(ctx, "data.read")
	if err != nil {
		return nil, err
	}
	if HasPermission(u, "*") {
		rows, err := a.DB.QueryContext(ctx, `SELECT id,name FROM data_files WHERE kind='business' ORDER BY name,id`)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		var result []DatasetSummary
		for rows.Next() {
			var item DatasetSummary
			if err := rows.Scan(&item.ID, &item.Name); err != nil {
				return nil, err
			}
			result = append(result, item)
		}
		return result, rows.Err()
	}
	rows, err := a.DB.QueryContext(ctx, `SELECT d.id,d.name,g.operations FROM data_files d JOIN grants g ON g.dataset_id=d.id WHERE d.kind='business' AND g.user_id=? ORDER BY d.name,d.id`, u.ID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	seen := map[string]struct{}{}
	var result []DatasetSummary
	for rows.Next() {
		var item DatasetSummary
		var operationsJSON string
		if err := rows.Scan(&item.ID, &item.Name, &operationsJSON); err != nil {
			return nil, err
		}
		var operations []string
		if json.Unmarshal([]byte(operationsJSON), &operations) != nil {
			return nil, Error(500, "invalid_grant", "授权操作配置无效")
		}
		allowed := false
		for _, operation := range operations {
			if operation == "read" || operation == "*" {
				allowed = true
				break
			}
		}
		if allowed {
			if _, ok := seen[item.ID]; !ok {
				seen[item.ID] = struct{}{}
				result = append(result, item)
			}
		}
	}
	return result, rows.Err()
}

// Schema returns only columns visible to a read grant.
func (a *App) Schema(ctx context.Context, datasetID, table string) ([]Field, error) {
	return a.SchemaForOperation(ctx, datasetID, table, "read")
}

// SchemaForOperation is useful to imports where a writer may not have read permission.
func (a *App) SchemaForOperation(ctx context.Context, datasetID, table, operation string) ([]Field, error) {
	policy, err := a.AuthorizeTable(ctx, datasetID, table, operation, nil)
	if err != nil {
		return nil, err
	}
	database, err := a.DatasetDB(ctx, datasetID)
	if err != nil {
		return nil, err
	}
	if err := lockDatabase(ctx, database); err != nil {
		return nil, err
	}
	defer database.Mu.Unlock()
	fields, err := a.rawSchema(ctx, database, table)
	if err != nil {
		return nil, err
	}
	if policy.AllColumns {
		return fields, nil
	}
	visible := make([]Field, 0, len(fields))
	for _, f := range fields {
		if _, ok := policy.Columns[strings.ToLower(f.Name)]; ok {
			visible = append(visible, f)
		}
	}
	if len(visible) == 0 {
		return nil, Error(403, "column_forbidden", "授权未包含可访问的字段")
	}
	return visible, nil
}

func (a *App) ListTables(ctx context.Context, datasetID string) ([]string, error) {
	if _, err := Require(ctx, "data.read"); err != nil {
		return nil, err
	}
	database, err := a.DatasetDB(ctx, datasetID)
	if err != nil {
		return nil, err
	}
	if err := lockDatabase(ctx, database); err != nil {
		return nil, err
	}
	defer database.Mu.Unlock()
	rows, err := database.DB.QueryContext(ctx, `SELECT table_name FROM information_schema.tables WHERE table_catalog='vault' AND table_schema = 'main' AND table_type = 'BASE TABLE' AND table_name NOT LIKE '\_rd\_%' ESCAPE '\' ORDER BY table_name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var tables []string
	for rows.Next() {
		var table string
		if err := rows.Scan(&table); err != nil {
			return nil, err
		}
		if _, err := a.AuthorizeTable(ctx, datasetID, table, "read", nil); err == nil {
			tables = append(tables, table)
		} else if !IsAPIError(err) {
			return nil, err
		}
	}
	return tables, rows.Err()
}

type filterCompiler struct {
	fields map[string]Field
	ref    func(Field) (string, []any)
	count  int
}

func (c *filterCompiler) compile(f Filter, depth int) (string, []any, []string, error) {
	if depth > 16 {
		return "", nil, nil, Error(400, "filter_too_deep", "筛选条件嵌套过深")
	}
	if len(f.Rules) > 0 || f.Logic != "" {
		logic := strings.ToLower(strings.TrimSpace(f.Logic))
		if logic == "" {
			logic = "and"
		}
		if logic != "and" && logic != "or" {
			return "", nil, nil, Error(400, "invalid_filter", "筛选逻辑仅支持 and 或 or")
		}
		if len(f.Rules) == 0 {
			return "", nil, nil, Error(400, "invalid_filter", "组合筛选不能为空")
		}
		parts := make([]string, 0, len(f.Rules))
		var args []any
		var cols []string
		for _, rule := range f.Rules {
			part, partArgs, partCols, err := c.compile(rule, depth+1)
			if err != nil {
				return "", nil, nil, err
			}
			parts = append(parts, "("+part+")")
			args = append(args, partArgs...)
			cols = append(cols, partCols...)
		}
		return strings.Join(parts, " "+strings.ToUpper(logic)+" "), args, cols, nil
	}
	c.count++
	if c.count > 100 {
		return "", nil, nil, Error(400, "too_many_filters", "筛选条件过多")
	}
	field, ok := c.fields[strings.ToLower(f.Field)]
	if !ok {
		return "", nil, nil, Error(400, "unknown_field", "筛选字段不存在")
	}
	ref, refArgs := c.ref(field)
	op := strings.ToLower(strings.TrimSpace(f.Op))
	col := []string{field.Name}
	switch op {
	case "eq", "ne", "lt", "lte", "gt", "gte":
		if f.Value == nil {
			if op == "eq" {
				return ref + " IS NULL", refArgs, col, nil
			}
			if op == "ne" {
				return ref + " IS NOT NULL", refArgs, col, nil
			}
			return "", nil, nil, Error(400, "invalid_filter", "空值只支持 eq 或 ne")
		}
		value, err := coerceValue(f.Value, field)
		if err != nil {
			return "", nil, nil, err
		}
		operators := map[string]string{"eq": "=", "ne": "<>", "lt": "<", "lte": "<=", "gt": ">", "gte": ">="}
		return ref + " " + operators[op] + " CAST(? AS " + field.DataType + ")", append(refArgs, value), col, nil
	case "in", "not_in":
		if len(f.Values) == 0 {
			if op == "in" {
				return "FALSE", nil, col, nil
			}
			return "TRUE", nil, col, nil
		}
		marks := make([]string, len(f.Values))
		values := make([]any, len(f.Values))
		for i := range marks {
			marks[i] = "CAST(? AS " + field.DataType + ")"
			value, err := coerceValue(f.Values[i], field)
			if err != nil {
				return "", nil, nil, err
			}
			values[i] = value
		}
		keyword := "IN"
		if op == "not_in" {
			keyword = "NOT IN"
		}
		return ref + " " + keyword + " (" + strings.Join(marks, ",") + ")", append(refArgs, values...), col, nil
	case "between":
		if len(f.Values) != 2 {
			return "", nil, nil, Error(400, "invalid_filter", "between 需要两个值")
		}
		first, err := coerceValue(f.Values[0], field)
		if err != nil {
			return "", nil, nil, err
		}
		second, err := coerceValue(f.Values[1], field)
		if err != nil {
			return "", nil, nil, err
		}
		return ref + " BETWEEN CAST(? AS " + field.DataType + ") AND CAST(? AS " + field.DataType + ")", append(refArgs, first, second), col, nil
	case "is_null":
		return ref + " IS NULL", refArgs, col, nil
	case "is_not_null":
		return ref + " IS NOT NULL", refArgs, col, nil
	case "contains", "starts_with", "ends_with":
		if field.DataType != "VARCHAR" {
			return "", nil, nil, Error(400, "invalid_filter", "文本匹配仅支持 VARCHAR 字段")
		}
		value, ok := f.Value.(string)
		if !ok {
			return "", nil, nil, Error(400, "invalid_filter", "文本匹配值必须是字符串")
		}
		value = strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(value)
		if op == "contains" {
			value = "%" + value + "%"
		} else if op == "starts_with" {
			value += "%"
		} else {
			value = "%" + value
		}
		return ref + ` LIKE CAST(? AS VARCHAR) ESCAPE '\'`, append(refArgs, value), col, nil
	default:
		return "", nil, nil, Error(400, "unsupported_filter", "不支持的筛选操作")
	}
}

func compileFilter(f *Filter, fields map[string]Field, ref func(Field) (string, []any)) (string, []any, []string, error) {
	if f == nil {
		return "", nil, nil, nil
	}
	return (&filterCompiler{fields: fields, ref: ref}).compile(*f, 0)
}

func (a *App) Query(ctx context.Context, req QueryRequest) (QueryResult, error) {
	start := nowUTC()
	if a.Config.QueryTimeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, a.Config.QueryTimeout)
		defer cancel()
	}
	u := CurrentUser(ctx)
	result, err := a.query(ctx, req)
	outcome := "success"
	if err != nil {
		outcome = "failed"
	}
	if u != nil {
		a.Audit(ctx, u.ID, "data", "query", req.DatasetID+"/"+req.Table, outcome, since(start))
	}
	return result, err
}

func (a *App) query(ctx context.Context, req QueryRequest) (result QueryResult, err error) {
	started := nowUTC()
	sqlTemplate := ""
	defer func() {
		if sqlTemplate == "" {
			return
		}
		outcome := "success"
		if err != nil {
			outcome = "failed"
		}
		a.QueryAudit(ctx, req.DatasetID, req.Table, QueryKind(ctx), sqlTemplate, outcome, since(started))
	}()
	_, err = a.AuthorizeTable(ctx, req.DatasetID, req.Table, "read", nil)
	if err != nil {
		return QueryResult{}, err
	}
	database, err := a.DatasetDB(ctx, req.DatasetID)
	if err != nil {
		return QueryResult{}, err
	}
	// Backup and schema operations share this lock. Hold it through row scanning
	// so a completed checkpoint can be copied without a new query starting.
	if err := lockDatabase(ctx, database); err != nil {
		return QueryResult{}, err
	}
	defer database.Mu.Unlock()
	fields, err := a.rawSchema(ctx, database, req.Table)
	if err != nil {
		return QueryResult{}, err
	}
	plan, err := a.prepareQuery(ctx, req, fields, []string{"read"}, true)
	if err != nil {
		return QueryResult{}, err
	}
	sqlTemplate = plan.querySQL
	tx, err := database.DB.BeginTx(ctx, nil)
	if err != nil {
		return QueryResult{}, err
	}
	defer tx.Rollback()
	var total int64
	if err := tx.QueryRowContext(ctx, plan.countSQL, plan.countArgs...).Scan(&total); err != nil {
		return QueryResult{}, err
	}
	rows, err := tx.QueryContext(ctx, plan.querySQL, plan.queryArgs...)
	if err != nil {
		return QueryResult{}, err
	}
	defer rows.Close()
	resultFields, resultRows, err := scanRows(rows)
	if err != nil {
		return QueryResult{}, err
	}
	if err := rows.Close(); err != nil {
		return QueryResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return QueryResult{}, err
	}
	return QueryResult{Fields: resultFields, Rows: resultRows, Total: total}, nil
}

type queryPlan struct {
	querySQL  string
	queryArgs []any
	countSQL  string
	countArgs []any
}

func (a *App) prepareQuery(ctx context.Context, req QueryRequest, fields []Field, operations []string, paged bool) (queryPlan, error) {
	allFields := fieldMap(fields)
	initial := make([]Policy, 0, len(operations))
	for _, operation := range operations {
		policy, err := a.AuthorizeTable(ctx, req.DatasetID, req.Table, operation, nil)
		if err != nil {
			return queryPlan{}, err
		}
		initial = append(initial, policy)
	}
	available := make([]string, 0, len(fields))
	for _, field := range fields {
		allowed := true
		for _, policy := range initial {
			if ensurePolicyColumns(policy, field.Name) != nil {
				allowed = false
				break
			}
		}
		if allowed {
			available = append(available, field.Name)
		}
	}
	selected := append([]string(nil), req.Fields...)
	if len(selected) == 0 {
		if len(req.Aggregates) > 0 {
			selected = append(selected, req.GroupBy...)
		} else {
			if len(available) == 0 {
				return queryPlan{}, Error(403, "column_forbidden", "授权未包含可访问的字段")
			}
			selected = available
		}
	}
	required := append(append(append([]string{}, selected...), req.GroupBy...), filterColumns(req.Filters...)...)
	for _, aggregate := range req.Aggregates {
		if aggregate.Field != "" && aggregate.Field != "*" {
			required = append(required, aggregate.Field)
		}
	}
	for i, column := range required {
		field, ok := allFields[strings.ToLower(column)]
		if !ok {
			return queryPlan{}, Error(400, "unknown_field", "查询字段不存在")
		}
		required[i] = field.Name
	}
	policies := make([]Policy, 0, len(operations))
	for _, operation := range operations {
		policy, err := a.AuthorizeTable(ctx, req.DatasetID, req.Table, operation, required)
		if err != nil {
			return queryPlan{}, err
		}
		policies = append(policies, policy)
	}
	if len(req.Aggregates) > 0 {
		groups := map[string]struct{}{}
		for _, group := range req.GroupBy {
			groups[strings.ToLower(group)] = struct{}{}
		}
		for _, column := range selected {
			if _, ok := groups[strings.ToLower(column)]; !ok {
				return queryPlan{}, Error(400, "invalid_group", "非聚合字段必须出现在 groupBy 中")
			}
		}
	}
	selectParts := make([]string, 0, len(selected)+len(req.Aggregates))
	outputNames := map[string]struct{}{}
	for _, column := range selected {
		field := allFields[strings.ToLower(column)]
		if _, exists := outputNames[strings.ToLower(field.Name)]; exists {
			return queryPlan{}, Error(400, "duplicate_field", "查询结果字段重名")
		}
		selectParts = append(selectParts, quoteIdentifier(field.Name))
		outputNames[strings.ToLower(field.Name)] = struct{}{}
	}
	for _, aggregate := range req.Aggregates {
		fn := strings.ToLower(aggregate.Function)
		sqlFn := map[string]string{"sum": "SUM", "count": "COUNT", "count_distinct": "COUNT", "avg": "AVG", "min": "MIN", "max": "MAX"}[fn]
		if sqlFn == "" {
			return queryPlan{}, Error(400, "unsupported_aggregate", "不支持的聚合函数")
		}
		if validatePublicIdentifier(aggregate.Alias, "聚合别名") != nil {
			return queryPlan{}, Error(400, "invalid_alias", "聚合别名无效")
		}
		if _, exists := outputNames[strings.ToLower(aggregate.Alias)]; exists {
			return queryPlan{}, Error(400, "duplicate_alias", "查询结果字段重名")
		}
		target := "*"
		if aggregate.Field != "" && aggregate.Field != "*" {
			field := allFields[strings.ToLower(aggregate.Field)]
			target = quoteIdentifier(field.Name)
		} else if fn != "count" {
			return queryPlan{}, Error(400, "invalid_aggregate", "该聚合函数必须指定字段")
		}
		if fn == "count_distinct" {
			selectParts = append(selectParts, "COUNT(DISTINCT "+target+") AS "+quoteIdentifier(aggregate.Alias))
		} else {
			selectParts = append(selectParts, sqlFn+"("+target+") AS "+quoteIdentifier(aggregate.Alias))
		}
		outputNames[strings.ToLower(aggregate.Alias)] = struct{}{}
	}
	if len(selectParts) == 0 {
		return queryPlan{}, Error(400, "empty_select", "查询字段不能为空")
	}
	userWhere, userArgs, userCols, err := compileFilter(combineFilters(req.Filters, nil), allFields, func(f Field) (string, []any) { return quoteIdentifier(f.Name), nil })
	if err != nil {
		return queryPlan{}, err
	}
	for _, policy := range policies {
		if err := ensurePolicyColumns(policy, userCols...); err != nil {
			return queryPlan{}, err
		}
	}
	whereParts := []string{}
	args := []any{}
	if userWhere != "" {
		whereParts = append(whereParts, "("+userWhere+")")
		args = append(args, userArgs...)
	}
	for _, policy := range policies {
		policyWhere, policyArgs, _, err := compileFilter(policy.Row, allFields, func(f Field) (string, []any) { return quoteIdentifier(f.Name), nil })
		if err != nil {
			return queryPlan{}, err
		}
		if policyWhere != "" {
			whereParts = append(whereParts, "("+policyWhere+")")
			args = append(args, policyArgs...)
		}
	}
	fromWhere := " FROM " + qualifiedTable(req.Table)
	if len(whereParts) > 0 {
		fromWhere += " WHERE " + strings.Join(whereParts, " AND ")
	}
	groupSQL := ""
	if len(req.GroupBy) > 0 {
		parts := make([]string, len(req.GroupBy))
		for i, group := range req.GroupBy {
			parts[i] = quoteIdentifier(allFields[strings.ToLower(group)].Name)
		}
		groupSQL = " GROUP BY " + strings.Join(parts, ",")
	}
	querySQL := "SELECT " + strings.Join(selectParts, ",") + fromWhere + groupSQL
	for _, order := range req.OrderBy {
		if _, ok := outputNames[strings.ToLower(order.Field)]; !ok {
			return queryPlan{}, Error(400, "invalid_order", "排序字段必须出现在查询结果中")
		}
		direction := strings.ToUpper(order.Direction)
		if direction == "" {
			direction = "ASC"
		}
		if direction != "ASC" && direction != "DESC" {
			return queryPlan{}, Error(400, "invalid_order", "排序方向仅支持 ASC 或 DESC")
		}
		if validatePublicIdentifier(order.Field, "排序字段") != nil {
			return queryPlan{}, Error(400, "invalid_order", "排序字段无效")
		}
		if !strings.Contains(querySQL, " ORDER BY ") {
			querySQL += " ORDER BY "
		} else {
			querySQL += ","
		}
		querySQL += quoteIdentifier(order.Field) + " " + direction
	}
	queryArgs := append([]any(nil), args...)
	if paged {
		maxRows := a.Config.MaxResultRows
		if maxRows <= 0 {
			maxRows = 1000
		}
		limit := req.Limit
		if limit <= 0 {
			limit = maxRows
		}
		if limit > maxRows {
			return queryPlan{}, Error(400, "result_limit_exceeded", "查询条数超过限制")
		}
		if req.Offset < 0 {
			return queryPlan{}, Error(400, "invalid_offset", "分页偏移不能为负数")
		}
		querySQL += " LIMIT ? OFFSET ?"
		queryArgs = append(queryArgs, limit, req.Offset)
	} else if req.Limit != 0 || req.Offset != 0 {
		return queryPlan{}, Error(400, "export_pagination_forbidden", "全量流式查询不接受分页参数")
	}
	countSQL := "SELECT COUNT(*)" + fromWhere
	if groupSQL != "" {
		countSQL = "SELECT COUNT(*) FROM (SELECT 1" + fromWhere + groupSQL + ") AS " + quoteIdentifier("_rd_count")
	}
	return queryPlan{querySQL: querySQL, queryArgs: queryArgs, countSQL: countSQL, countArgs: append([]any(nil), args...)}, nil
}

// StreamQuery emits one authorized, lossless row at a time from a single
// DuckDB snapshot. Export requires both read and export scopes.
func (a *App) StreamQuery(ctx context.Context, req QueryRequest, operation string, onSchema func([]Field) error, onRow func([]any) error) (total int64, err error) {
	started := nowUTC()
	sqlTemplate := ""
	queryKind := QueryKind(ctx)
	if operation == "export" {
		queryKind = "export"
	}
	defer func() {
		if sqlTemplate == "" {
			return
		}
		outcome := "success"
		if err != nil {
			outcome = "failed"
		}
		a.QueryAudit(ctx, req.DatasetID, req.Table, queryKind, sqlTemplate, outcome, since(started))
	}()
	operations := []string{"read"}
	if operation == "export" {
		operations = append(operations, "export")
	} else if operation != "read" {
		return 0, Error(400, "invalid_operation", "流式查询仅支持 read 或 export")
	}
	for _, op := range operations {
		if _, err := a.AuthorizeTable(ctx, req.DatasetID, req.Table, op, nil); err != nil {
			return 0, err
		}
	}
	database, err := a.DatasetDB(ctx, req.DatasetID)
	if err != nil {
		return 0, err
	}
	if err = lockDatabase(ctx, database); err != nil {
		return 0, err
	}
	defer database.Mu.Unlock()
	fields, err := a.rawSchema(ctx, database, req.Table)
	if err != nil {
		return 0, err
	}
	plan, err := a.prepareQuery(ctx, req, fields, operations, false)
	if err != nil {
		return 0, err
	}
	sqlTemplate = plan.querySQL
	tx, err := database.DB.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	if err = tx.QueryRowContext(ctx, plan.countSQL, plan.countArgs...).Scan(&total); err != nil {
		return 0, err
	}
	rows, err := tx.QueryContext(ctx, plan.querySQL, plan.queryArgs...)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	resultFields, err := rowFields(rows)
	if err != nil {
		return 0, err
	}
	if onSchema != nil {
		if err = onSchema(resultFields); err != nil {
			return 0, err
		}
	}
	for rows.Next() {
		values := make([]any, len(resultFields))
		pointers := make([]any, len(values))
		for i := range values {
			pointers[i] = &values[i]
		}
		if err = rows.Scan(pointers...); err != nil {
			return 0, err
		}
		for i := range values {
			values[i] = normalizeWireValue(values[i], resultFields[i].DataType)
		}
		if onRow != nil {
			if err = onRow(values); err != nil {
				return 0, err
			}
		}
	}
	if err = rows.Err(); err != nil {
		return 0, err
	}
	if err = rows.Close(); err != nil {
		return 0, err
	}
	if err = tx.Commit(); err != nil {
		return 0, err
	}
	return total, nil
}

func filterColumns(filters ...Filter) []string {
	var out []string
	var walk func(Filter)
	walk = func(f Filter) {
		if f.Field != "" {
			out = append(out, f.Field)
		}
		for _, r := range f.Rules {
			walk(r)
		}
	}
	for _, f := range filters {
		walk(f)
	}
	return out
}

func scanRows(rows *sql.Rows) ([]Field, []map[string]any, error) {
	fields, err := rowFields(rows)
	if err != nil {
		return nil, nil, err
	}
	columns, err := rows.Columns()
	if err != nil {
		return nil, nil, err
	}
	result := make([]map[string]any, 0)
	for rows.Next() {
		values := make([]any, len(columns))
		pointers := make([]any, len(columns))
		for i := range values {
			pointers[i] = &values[i]
		}
		if err := rows.Scan(pointers...); err != nil {
			return nil, nil, err
		}
		row := make(map[string]any, len(columns))
		for i, name := range columns {
			row[name] = normalizeWireValue(values[i], fields[i].DataType)
		}
		result = append(result, row)
	}
	return fields, result, rows.Err()
}

func rowFields(rows *sql.Rows) ([]Field, error) {
	columns, err := rows.Columns()
	if err != nil {
		return nil, err
	}
	types, err := rows.ColumnTypes()
	if err != nil {
		return nil, err
	}
	fields := make([]Field, len(columns))
	for i, name := range columns {
		typ := types[i].DatabaseTypeName()
		normalized, e := normalizeFieldType(typ)
		if e != nil {
			return nil, e
		}
		fields[i] = Field{Name: name, DataType: normalized, Nullable: true, Ordinal: i + 1}
	}
	return fields, nil
}

func nowUTC() int64                   { return timeNow().UnixNano() }
func since(start int64) time.Duration { return time.Duration(timeNow().UnixNano() - start) }

var timeNow = func() time.Time { return time.Now().UTC() }
