package app

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"math/big"
	"strconv"
	"strings"
)

func requestFingerprint(v any) (string, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:]), nil
}

func runIdempotent[T any](ctx context.Context, database *Database, actor, key, fingerprint string, fn func(*sql.Tx) (T, error)) (T, error) {
	var zero T
	if err := lockDatabase(ctx, database); err != nil {
		return zero, err
	}
	defer database.Mu.Unlock()
	return runIdempotentLocked(ctx, database, actor, key, fingerprint, fn)
}

func runIdempotentLocked[T any](ctx context.Context, database *Database, actor, key, fingerprint string, fn func(*sql.Tx) (T, error)) (T, error) {
	var zero T
	if strings.TrimSpace(key) == "" {
		return zero, Error(400, "idempotency_required", "写操作必须提供 Idempotency-Key")
	}
	tx, err := database.DB.BeginTx(ctx, nil)
	if err != nil {
		return zero, err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS "main"."_rd_operations" (key VARCHAR PRIMARY KEY, actor VARCHAR NOT NULL, fingerprint VARCHAR NOT NULL, result VARCHAR NOT NULL, created_at TIMESTAMP NOT NULL)`); err != nil {
		return zero, err
	}
	var existingActor, existingFingerprint, resultJSON string
	err = tx.QueryRowContext(ctx, `SELECT actor,fingerprint,result FROM "main"."_rd_operations" WHERE key=?`, key).Scan(&existingActor, &existingFingerprint, &resultJSON)
	if err == nil {
		if existingActor != actor || existingFingerprint != fingerprint {
			return zero, Error(409, "idempotency_conflict", "Idempotency-Key 已用于不同请求")
		}
		if err = json.Unmarshal([]byte(resultJSON), &zero); err != nil {
			return zero, err
		}
		if err = tx.Commit(); err != nil {
			return zero, err
		}
		return zero, nil
	}
	if err != sql.ErrNoRows {
		return zero, err
	}
	result, err := fn(tx)
	if err != nil {
		return zero, err
	}
	b, err := json.Marshal(result)
	if err != nil {
		return zero, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO "main"."_rd_operations" VALUES (?,?,?,?,current_timestamp)`, key, actor, fingerprint, string(b)); err != nil {
		return zero, err
	}
	if err = tx.Commit(); err != nil {
		return zero, err
	}
	return result, nil
}

func coerceValue(value any, field Field) (any, error) {
	if value == nil {
		if !field.Nullable {
			return nil, Error(400, "null_not_allowed", "字段 "+field.Name+" 不允许为空")
		}
		return nil, nil
	}
	t := strings.ToUpper(field.DataType)
	if n, ok := value.(json.Number); ok {
		value = string(n)
	}
	if strings.Contains(t, "BIGINT") || strings.Contains(t, "HUGEINT") || strings.HasPrefix(t, "DECIMAL") {
		s, ok := value.(string)
		if !ok {
			return nil, Error(400, "lossy_number", "BIGINT、HUGEINT 和 DECIMAL 必须使用 JSON 字符串传输")
		}
		if strings.TrimSpace(s) == "" {
			return nil, Error(400, "invalid_value", "数值不能为空")
		}
		return s, nil
	}
	switch t {
	case "TINYINT", "SMALLINT", "INTEGER", "UTINYINT", "USMALLINT", "UINTEGER":
		switch n := value.(type) {
		case float64:
			if math.Trunc(n) != n {
				return nil, Error(400, "invalid_value", "整数列不能写入小数")
			}
			return int64(n), nil
		case int:
			return int64(n), nil
		case int64:
			return n, nil
		case string:
			if _, e := strconv.ParseInt(n, 10, 64); e != nil {
				return nil, Error(400, "invalid_value", "整数格式无效")
			}
			return n, nil
		default:
			return nil, Error(400, "invalid_value", "整数格式无效")
		}
	case "REAL", "FLOAT", "DOUBLE":
		switch n := value.(type) {
		case float64:
			return n, nil
		case float32:
			return n, nil
		case int:
			return n, nil
		case int64:
			return n, nil
		case string:
			if _, e := strconv.ParseFloat(n, 64); e != nil {
				return nil, Error(400, "invalid_value", "浮点数格式无效")
			}
			return n, nil
		default:
			return nil, Error(400, "invalid_value", "浮点数格式无效")
		}
	case "BOOLEAN":
		if _, ok := value.(bool); !ok {
			return nil, Error(400, "invalid_value", "布尔字段必须是 true 或 false")
		}
		return value, nil
	case "VARCHAR", "DATE", "TIME", "TIME WITH TIME ZONE", "TIMESTAMP", "TIMESTAMP_S", "TIMESTAMP_MS", "TIMESTAMP_NS", "TIMESTAMP WITH TIME ZONE", "UUID":
		if _, ok := value.(string); !ok {
			return nil, Error(400, "invalid_value", "字段 "+field.Name+" 必须是字符串")
		}
		return value, nil
	case "JSON":
		if s, ok := value.(string); ok {
			if !json.Valid([]byte(s)) {
				return nil, Error(400, "invalid_value", "JSON 字段格式无效")
			}
			return s, nil
		}
		b, e := json.Marshal(value)
		if e != nil {
			return nil, Error(400, "invalid_value", "JSON 字段格式无效")
		}
		return string(b), nil
	default:
		return nil, Error(400, "unsupported_type", "字段类型不在无损支持范围内")
	}
}

func canonicalValues(values map[string]any, fields map[string]Field) (map[string]any, error) {
	out := make(map[string]any, len(values))
	seen := map[string]struct{}{}
	for name, value := range values {
		field, ok := fields[strings.ToLower(name)]
		if !ok {
			return nil, Error(400, "unknown_field", "写入字段不存在")
		}
		lower := strings.ToLower(field.Name)
		if _, ok := seen[lower]; ok {
			return nil, Error(400, "duplicate_field", "写入字段重复")
		}
		seen[lower] = struct{}{}
		v, err := coerceValue(value, field)
		if err != nil {
			return nil, err
		}
		out[field.Name] = v
	}
	return out, nil
}

func (a *App) Mutate(ctx context.Context, req MutationRequest) (MutationResult, error) {
	start := nowUTC()
	if a.Config.QueryTimeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, a.Config.QueryTimeout)
		defer cancel()
	}
	u := CurrentUser(ctx)
	result, err := a.mutate(ctx, req)
	outcome := "success"
	if err != nil {
		outcome = "failed"
	}
	if u != nil {
		a.Audit(ctx, u.ID, "data", "mutate", req.DatasetID+"/"+req.Table, outcome, since(start))
	}
	return result, err
}

func (a *App) mutate(ctx context.Context, req MutationRequest) (MutationResult, error) {
	_, err := a.AuthorizeTable(ctx, req.DatasetID, req.Table, "write", nil)
	if err != nil {
		return MutationResult{}, err
	}
	u := CurrentUser(ctx)
	database, err := a.DatasetDB(ctx, req.DatasetID)
	if err != nil {
		return MutationResult{}, err
	}
	if err := lockDatabase(ctx, database); err != nil {
		return MutationResult{}, err
	}
	defer database.Mu.Unlock()
	fields, err := a.rawSchema(ctx, database, req.Table)
	if err != nil {
		return MutationResult{}, err
	}
	fieldsByName := fieldMap(fields)
	if len(req.Operations) == 0 || len(req.Operations) > 1000 {
		return MutationResult{}, Error(400, "invalid_mutation_count", "事务写入操作数必须在 1 到 1000 之间")
	}
	fingerprint, err := requestFingerprint(struct {
		DatasetID, Table string
		Operations       []RecordMutation
	}{req.DatasetID, req.Table, req.Operations})
	if err != nil {
		return MutationResult{}, err
	}
	return runIdempotentLocked(ctx, database, u.ID, req.IdempotencyKey, fingerprint, func(tx *sql.Tx) (MutationResult, error) {
		var result MutationResult
		for _, operation := range req.Operations {
			action := strings.ToLower(operation.Action)
			values, err := canonicalValues(operation.Values, fieldsByName)
			if err != nil {
				return result, err
			}
			valueColumns := make([]string, 0, len(values))
			for name := range values {
				valueColumns = append(valueColumns, name)
			}
			requiredColumns := append([]string(nil), valueColumns...)
			if operation.Filter != nil {
				requiredColumns = append(requiredColumns, filterColumns(*operation.Filter)...)
			}
			operationPolicy, err := a.AuthorizeTable(ctx, req.DatasetID, req.Table, "write", requiredColumns)
			if err != nil {
				return result, err
			}
			switch action {
			case "insert":
				if operation.Filter != nil {
					return result, Error(400, "invalid_insert", "新增操作不能包含筛选条件")
				}
				if len(values) == 0 {
					return result, Error(400, "empty_values", "新增记录不能为空")
				}
				for _, field := range fields {
					if _, provided := values[field.Name]; !provided && field.Default != nil && !safeStoredDefault(fmt.Sprint(field.Default)) {
						return result, Error(422, "unsafe_default", "目标表包含不受支持的默认值表达式，必须显式提供该字段")
					}
				}
				if err := checkInsertPolicy(ctx, tx, operationPolicy, fieldsByName, values); err != nil {
					return result, err
				}
				cols, marks, args := orderedInsert(fields, values)
				query := "INSERT INTO " + qualifiedTable(req.Table) + " (" + strings.Join(cols, ",") + ") VALUES (" + strings.Join(marks, ",") + ")"
				r, e := tx.ExecContext(ctx, query, args...)
				if e != nil {
					return result, e
				}
				n, _ := r.RowsAffected()
				result.Inserted += n
			case "update":
				if operation.Filter == nil {
					return result, Error(400, "filter_required", "修改记录必须提供筛选条件")
				}
				if len(values) == 0 {
					return result, Error(400, "empty_values", "修改记录不能为空")
				}
				n, e := executeUpdate(ctx, tx, req.Table, operation.Filter, operationPolicy, fields, fieldsByName, values)
				if e != nil {
					return result, e
				}
				result.Updated += n
			case "delete":
				if operation.Filter == nil {
					return result, Error(400, "filter_required", "删除记录必须提供筛选条件")
				}
				if len(values) > 0 {
					return result, Error(400, "invalid_delete", "删除操作不能包含写入值")
				}
				n, e := executeDelete(ctx, tx, req.Table, operation.Filter, operationPolicy, fieldsByName)
				if e != nil {
					return result, e
				}
				result.Deleted += n
			default:
				return result, Error(400, "unsupported_mutation", "写操作仅支持 insert、update、delete")
			}
		}
		return result, nil
	})
}

func orderedInsert(fields []Field, values map[string]any) ([]string, []string, []any) {
	var cols, marks []string
	var args []any
	for _, f := range fields {
		if v, ok := values[f.Name]; ok {
			cols = append(cols, quoteIdentifier(f.Name))
			marks = append(marks, "CAST(? AS "+f.DataType+")")
			args = append(args, v)
		}
	}
	return cols, marks, args
}

func checkInsertPolicy(ctx context.Context, tx *sql.Tx, policy Policy, fields map[string]Field, values map[string]any) error {
	if policy.Row == nil {
		return nil
	}
	expr, args, cols, err := compileFilter(policy.Row, fields, func(f Field) (string, []any) {
		v, ok := values[f.Name]
		if !ok {
			return "NULL", nil
		}
		return "CAST(? AS " + f.DataType + ")", []any{v}
	})
	if err != nil {
		return err
	}
	for _, col := range cols {
		if _, ok := values[fields[strings.ToLower(col)].Name]; !ok {
			return Error(403, "row_forbidden", "新增记录缺少行权限条件字段")
		}
	}
	var allowed bool
	if err := tx.QueryRowContext(ctx, "SELECT COALESCE(("+expr+"), FALSE)", args...).Scan(&allowed); err != nil {
		return err
	}
	if !allowed {
		return Error(403, "row_forbidden", "新增记录超出行权限范围")
	}
	return nil
}

// CompilePolicySQL generates a bound row predicate from a previously returned
// Policy. It is intended for import/export code that operates in its own
// transaction. qualifier, when set, must be a simple server-owned table alias.
func CompilePolicySQL(policy Policy, fields []Field, qualifier string) (string, []any, error) {
	if policy.Row == nil {
		return "", nil, nil
	}
	if qualifier != "" {
		if err := validatePublicIdentifier(qualifier, "表别名"); err != nil {
			return "", nil, err
		}
	}
	byName := fieldMap(fields)
	expr, args, _, err := compileFilter(policy.Row, byName, func(f Field) (string, []any) {
		ref := quoteIdentifier(f.Name)
		if qualifier != "" {
			ref = quoteIdentifier(qualifier) + "." + ref
		}
		return ref, nil
	})
	return expr, args, err
}

// CheckPolicyValues verifies a complete prospective row against a write
// policy inside the caller's transaction. It is used by bulk imports before
// any row is inserted or merged.
func CheckPolicyValues(ctx context.Context, tx *sql.Tx, policy Policy, fields []Field, fullRow map[string]any) error {
	byName := fieldMap(fields)
	values, err := canonicalValues(fullRow, byName)
	if err != nil {
		return err
	}
	return checkInsertPolicy(ctx, tx, policy, byName, values)
}

func executeUpdate(ctx context.Context, tx *sql.Tx, table string, userFilter *Filter, policy Policy, fields []Field, fieldsByName map[string]Field, values map[string]any) (int64, error) {
	userSQL, userArgs, userCols, err := compileFilter(userFilter, fieldsByName, func(f Field) (string, []any) { return quoteIdentifier(f.Name), nil })
	if err != nil {
		return 0, err
	}
	if err = ensurePolicyColumns(policy, userCols...); err != nil {
		return 0, err
	}
	oldPolicySQL, oldPolicyArgs, _, err := compileFilter(policy.Row, fieldsByName, func(f Field) (string, []any) { return quoteIdentifier(f.Name), nil })
	if err != nil {
		return 0, err
	}
	newPolicySQL, newPolicyArgs, _, err := compileFilter(policy.Row, fieldsByName, func(f Field) (string, []any) {
		if v, ok := values[f.Name]; ok {
			return "CAST(? AS " + f.DataType + ")", []any{v}
		}
		return quoteIdentifier(f.Name), nil
	})
	if err != nil {
		return 0, err
	}
	sets := []string{}
	args := []any{}
	for _, f := range fields {
		if v, ok := values[f.Name]; ok {
			sets = append(sets, quoteIdentifier(f.Name)+"=CAST(? AS "+f.DataType+")")
			args = append(args, v)
		}
	}
	where := []string{"(" + userSQL + ")"}
	args = append(args, userArgs...)
	if oldPolicySQL != "" {
		where = append(where, "("+oldPolicySQL+")")
		args = append(args, oldPolicyArgs...)
	}
	if newPolicySQL != "" {
		where = append(where, "COALESCE(("+newPolicySQL+"),FALSE)")
		args = append(args, newPolicyArgs...)
	}
	r, err := tx.ExecContext(ctx, "UPDATE "+qualifiedTable(table)+" SET "+strings.Join(sets, ",")+" WHERE "+strings.Join(where, " AND "), args...)
	if err != nil {
		return 0, err
	}
	return r.RowsAffected()
}

func executeDelete(ctx context.Context, tx *sql.Tx, table string, userFilter *Filter, policy Policy, fields map[string]Field) (int64, error) {
	userSQL, userArgs, userCols, err := compileFilter(userFilter, fields, func(f Field) (string, []any) { return quoteIdentifier(f.Name), nil })
	if err != nil {
		return 0, err
	}
	if err = ensurePolicyColumns(policy, userCols...); err != nil {
		return 0, err
	}
	policySQL, policyArgs, _, err := compileFilter(policy.Row, fields, func(f Field) (string, []any) { return quoteIdentifier(f.Name), nil })
	if err != nil {
		return 0, err
	}
	where := "(" + userSQL + ")"
	args := userArgs
	if policySQL != "" {
		where += " AND (" + policySQL + ")"
		args = append(args, policyArgs...)
	}
	r, err := tx.ExecContext(ctx, "DELETE FROM "+qualifiedTable(table)+" WHERE "+where, args...)
	if err != nil {
		return 0, err
	}
	return r.RowsAffected()
}

func (a *App) MutateSchema(ctx context.Context, req SchemaMutationRequest) (result SchemaMutationResult, err error) {
	start := nowUTC()
	if a.Config.QueryTimeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, a.Config.QueryTimeout)
		defer cancel()
	}
	u := CurrentUser(ctx)
	defer func() {
		outcome := "success"
		if err != nil {
			outcome = "failed"
		}
		if u != nil {
			a.Audit(ctx, u.ID, "schema", req.Action, req.DatasetID+"/"+req.Table, outcome, since(start))
		}
	}()
	schemaAction := strings.ToLower(req.Action)
	var authorizationColumns []string
	switch schemaAction {
	case "create_table":
		for _, field := range req.Fields {
			authorizationColumns = append(authorizationColumns, field.Name)
		}
		authorizationColumns = append(authorizationColumns, req.PrimaryKey...)
		for _, key := range req.UniqueKeys {
			authorizationColumns = append(authorizationColumns, key...)
		}
	case "add_column":
		if req.Field != nil {
			authorizationColumns = []string{req.Field.Name}
		}
	case "drop_column", "alter_type":
		authorizationColumns = []string{req.Column}
	case "rename_column":
		authorizationColumns = []string{req.Column, req.NewName}
	case "drop_table":
	default:
		return SchemaMutationResult{}, Error(400, "unsupported_schema_mutation", "不支持的表结构操作")
	}
	policy, err := a.AuthorizeTable(ctx, req.DatasetID, req.Table, "schema", authorizationColumns)
	if err != nil {
		return SchemaMutationResult{}, err
	}
	database, err := a.DatasetDB(ctx, req.DatasetID)
	if err != nil {
		return SchemaMutationResult{}, err
	}
	fingerprint, err := requestFingerprint(struct {
		Action, Table            string
		Field                    *FieldDefinition
		Fields                   []FieldDefinition
		PrimaryKey               []string
		UniqueKeys               [][]string
		Column, NewName, NewType string
	}{req.Action, req.Table, req.Field, req.Fields, req.PrimaryKey, req.UniqueKeys, req.Column, req.NewName, req.NewType})
	if err != nil {
		return SchemaMutationResult{}, err
	}
	return runIdempotent(ctx, database, u.ID, req.IdempotencyKey, fingerprint, func(tx *sql.Tx) (SchemaMutationResult, error) {
		action := schemaAction
		result := SchemaMutationResult{Action: action, Table: req.Table}
		var statement string
		switch action {
		case "create_table":
			if len(req.Fields) == 0 {
				return result, Error(400, "empty_schema", "建表字段不能为空")
			}
			defs, err := compileFieldDefinitions(req.Fields, policy)
			if err != nil {
				return result, err
			}
			constraints, err := compileTableConstraints(req.Fields, req.PrimaryKey, req.UniqueKeys, policy)
			if err != nil {
				return result, err
			}
			defs = append(defs, constraints...)
			statement = "CREATE TABLE " + qualifiedTable(req.Table) + " (" + strings.Join(defs, ",") + ")"
		case "drop_table":
			statement = "DROP TABLE " + qualifiedTable(req.Table)
		case "add_column":
			if req.Field == nil {
				return result, Error(400, "field_required", "缺少字段定义")
			}
			defs, err := compileFieldDefinitions([]FieldDefinition{*req.Field}, policy)
			if err != nil {
				return result, err
			}
			statement = "ALTER TABLE " + qualifiedTable(req.Table) + " ADD COLUMN " + defs[0]
		case "drop_column":
			if err := validatePublicIdentifier(req.Column, "字段"); err != nil {
				return result, err
			}
			if err := ensurePolicyColumns(policy, req.Column); err != nil {
				return result, err
			}
			statement = "ALTER TABLE " + qualifiedTable(req.Table) + " DROP COLUMN " + quoteIdentifier(req.Column)
		case "rename_column":
			if err := validatePublicIdentifier(req.Column, "字段"); err != nil {
				return result, err
			}
			if err := validatePublicIdentifier(req.NewName, "字段"); err != nil {
				return result, err
			}
			if err := ensurePolicyColumns(policy, req.Column, req.NewName); err != nil {
				return result, err
			}
			statement = "ALTER TABLE " + qualifiedTable(req.Table) + " RENAME " + quoteIdentifier(req.Column) + " TO " + quoteIdentifier(req.NewName)
		case "alter_type":
			if err := validatePublicIdentifier(req.Column, "字段"); err != nil {
				return result, err
			}
			if err := ensurePolicyColumns(policy, req.Column); err != nil {
				return result, err
			}
			typ, err := normalizeFieldType(req.NewType)
			if err != nil {
				return result, err
			}
			statement = "ALTER TABLE " + qualifiedTable(req.Table) + " ALTER COLUMN " + quoteIdentifier(req.Column) + " SET DATA TYPE " + typ
		}
		if _, err := tx.ExecContext(ctx, statement); err != nil {
			return result, err
		}
		return result, nil
	})
}

func compileFieldDefinitions(fields []FieldDefinition, policy Policy) ([]string, error) {
	out := make([]string, 0, len(fields))
	seen := map[string]struct{}{}
	for _, f := range fields {
		if err := validatePublicIdentifier(f.Name, "字段"); err != nil {
			return nil, err
		}
		lower := strings.ToLower(f.Name)
		if _, ok := seen[lower]; ok {
			return nil, Error(400, "duplicate_field", "字段名重复")
		}
		seen[lower] = struct{}{}
		if err := ensurePolicyColumns(policy, f.Name); err != nil {
			return nil, err
		}
		typ, err := normalizeFieldType(f.DataType)
		if err != nil {
			return nil, err
		}
		definition := quoteIdentifier(f.Name) + " " + typ
		if f.Default != nil {
			literal, err := safeDefaultLiteral(f.Default, typ)
			if err != nil {
				return nil, err
			}
			definition += " DEFAULT " + literal
		}
		if !f.Nullable || f.PrimaryKey {
			definition += " NOT NULL"
		}
		if f.PrimaryKey {
			definition += " PRIMARY KEY"
		} else if f.Unique {
			definition += " UNIQUE"
		}
		out = append(out, definition)
	}
	return out, nil
}

func compileTableConstraints(fields []FieldDefinition, primaryKey []string, uniqueKeys [][]string, policy Policy) ([]string, error) {
	byName := map[string]string{}
	fieldPrimary := false
	for _, field := range fields {
		byName[strings.ToLower(field.Name)] = field.Name
		if field.PrimaryKey {
			fieldPrimary = true
		}
	}
	if fieldPrimary && len(primaryKey) > 0 {
		return nil, Error(400, "duplicate_primary_key", "主键只能定义一次")
	}
	compileKey := func(columns []string) (string, error) {
		if len(columns) == 0 {
			return "", Error(400, "empty_constraint", "约束字段不能为空")
		}
		quoted := make([]string, len(columns))
		seen := map[string]struct{}{}
		for i, column := range columns {
			actual, ok := byName[strings.ToLower(column)]
			if !ok {
				return "", Error(400, "unknown_field", "约束字段不存在")
			}
			lower := strings.ToLower(actual)
			if _, ok := seen[lower]; ok {
				return "", Error(400, "duplicate_field", "约束字段重复")
			}
			seen[lower] = struct{}{}
			if err := ensurePolicyColumns(policy, actual); err != nil {
				return "", err
			}
			quoted[i] = quoteIdentifier(actual)
		}
		return "(" + strings.Join(quoted, ",") + ")", nil
	}
	var result []string
	if len(primaryKey) > 0 {
		key, err := compileKey(primaryKey)
		if err != nil {
			return nil, err
		}
		result = append(result, "PRIMARY KEY "+key)
	}
	for _, columns := range uniqueKeys {
		key, err := compileKey(columns)
		if err != nil {
			return nil, err
		}
		result = append(result, "UNIQUE "+key)
	}
	return result, nil
}

func safeDefaultLiteral(value any, dataType string) (string, error) {
	field := Field{Name: "default", DataType: dataType, Nullable: true}
	coerced, err := coerceValue(value, field)
	if err != nil {
		return "", err
	}
	if coerced == nil {
		return "NULL", nil
	}
	switch dataType {
	case "BOOLEAN":
		if coerced.(bool) {
			return "TRUE", nil
		}
		return "FALSE", nil
	case "TINYINT", "SMALLINT", "INTEGER", "UTINYINT", "USMALLINT", "UINTEGER":
		return fmt.Sprint(coerced), nil
	case "REAL", "FLOAT", "DOUBLE":
		switch n := coerced.(type) {
		case float64:
			return strconv.FormatFloat(n, 'g', -1, 64), nil
		case float32:
			return strconv.FormatFloat(float64(n), 'g', -1, 32), nil
		case string:
			v, e := strconv.ParseFloat(n, 64)
			if e != nil {
				return "", Error(400, "invalid_default", "默认值无效")
			}
			return strconv.FormatFloat(v, 'g', -1, 64), nil
		default:
			return fmt.Sprint(n), nil
		}
	case "BIGINT", "HUGEINT", "UBIGINT", "UHUGEINT":
		s := fmt.Sprint(coerced)
		if _, ok := new(big.Int).SetString(s, 10); !ok {
			return "", Error(400, "invalid_default", "整数默认值无效")
		}
		return s, nil
	}
	if strings.HasPrefix(dataType, "DECIMAL(") {
		s := fmt.Sprint(coerced)
		if !isDecimalText(s) {
			return "", Error(400, "invalid_default", "DECIMAL 默认值无效")
		}
		return s, nil
	}
	return sqlLiteral(fmt.Sprint(coerced)), nil
}

func isDecimalText(s string) bool {
	if s == "" {
		return false
	}
	i := 0
	if s[0] == '+' || s[0] == '-' {
		i++
		if i == len(s) {
			return false
		}
	}
	digits := 0
	dots := 0
	for ; i < len(s); i++ {
		if s[i] >= '0' && s[i] <= '9' {
			digits++
			continue
		}
		if s[i] == '.' && dots == 0 {
			dots++
			continue
		}
		return false
	}
	return digits > 0
}

func safeStoredDefault(expression string) bool {
	s := strings.TrimSpace(expression)
	upper := strings.ToUpper(s)
	if upper == "NULL" || upper == "TRUE" || upper == "FALSE" || isDecimalText(s) {
		return true
	}
	if len(s) >= 2 && s[0] == '\'' && s[len(s)-1] == '\'' {
		for i := 1; i < len(s)-1; i++ {
			if s[i] == '\'' {
				if i+1 >= len(s)-1 || s[i+1] != '\'' {
					return false
				}
				i++
			}
		}
		return true
	}
	return false
}
