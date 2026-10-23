package app

import (
	"context"
	"encoding/json"
	"strings"
)

type grantScope struct {
	allColumns bool
	columns    map[string]struct{}
	row        *Filter
	allRows    bool
}

func (s grantScope) covers(columns []string) bool {
	if s.allColumns {
		return true
	}
	for _, column := range columns {
		if _, ok := s.columns[strings.ToLower(column)]; !ok {
			return false
		}
	}
	return true
}

func globalPermissionForOperation(operation string) string {
	switch operation {
	case "read":
		return "data.read"
	case "write":
		return "data.write"
	case "schema":
		return "schema.manage"
	case "export":
		return "data.export"
	default:
		return ""
	}
}

// AuthorizeTable combines the global capability with the table grant. Admin
// users carrying * bypass grants; internal tables never do.
func (a *App) AuthorizeTable(ctx context.Context, datasetID, table, operation string, columns []string) (Policy, error) {
	if err := validatePublicIdentifier(table, "表"); err != nil {
		return Policy{}, err
	}
	perm := globalPermissionForOperation(operation)
	if perm == "" {
		return Policy{}, Error(400, "invalid_operation", "不支持的授权操作")
	}
	u, err := Require(ctx, perm)
	if err != nil {
		return Policy{}, err
	}
	if HasPermission(u, "*") {
		return Policy{Operation: operation, AllColumns: true}, nil
	}
	rows, err := a.DB.QueryContext(ctx, `SELECT operations, columns_json, row_filter FROM grants WHERE user_id = ? AND dataset_id = ? AND table_name IN (?, '*')`, u.ID, datasetID, table)
	if err != nil {
		return Policy{}, err
	}
	defer rows.Close()
	var scopes []grantScope
	for rows.Next() {
		var operationsJSON, columnsJSON, rowJSON string
		if err := rows.Scan(&operationsJSON, &columnsJSON, &rowJSON); err != nil {
			return Policy{}, err
		}
		var operations []string
		if json.Unmarshal([]byte(operationsJSON), &operations) != nil {
			return Policy{}, Error(500, "invalid_grant", "授权操作配置无效")
		}
		allowed := false
		for _, op := range operations {
			if op == operation || op == "*" {
				allowed = true
				break
			}
		}
		if !allowed {
			continue
		}
		scope := grantScope{columns: map[string]struct{}{}}
		var allowedColumns []string
		if json.Unmarshal([]byte(columnsJSON), &allowedColumns) != nil {
			return Policy{}, Error(500, "invalid_grant", "授权列配置无效")
		}
		for _, col := range allowedColumns {
			if col == "*" {
				scope.allColumns = true
				continue
			}
			if validatePublicIdentifier(col, "字段") == nil {
				scope.columns[strings.ToLower(col)] = struct{}{}
			}
		}
		if strings.TrimSpace(rowJSON) == "" || strings.TrimSpace(rowJSON) == "null" {
			scope.allRows = true
		} else {
			var f Filter
			if err := json.Unmarshal([]byte(rowJSON), &f); err != nil {
				return Policy{}, Error(500, "invalid_grant", "授权行条件配置无效")
			}
			scope.row = &f
		}
		scopes = append(scopes, scope)
	}
	if err := rows.Err(); err != nil {
		return Policy{}, err
	}
	if len(scopes) == 0 {
		return Policy{}, Error(403, "table_forbidden", "没有数据表操作权限")
	}
	// A grant is an atomic scope: its columns and row predicate must stay
	// together. Only grants that independently cover every requested column
	// participate in the row-scope OR.
	eligible := make([]grantScope, 0, len(scopes))
	for _, scope := range scopes {
		if scope.covers(columns) {
			eligible = append(eligible, scope)
		}
	}
	if len(eligible) == 0 {
		return Policy{}, Error(403, "column_forbidden", "没有单一授权范围覆盖全部请求字段")
	}
	policy := Policy{Operation: operation, Columns: map[string]struct{}{}}
	if len(columns) > 0 {
		for _, column := range columns {
			policy.Columns[strings.ToLower(column)] = struct{}{}
		}
	} else {
		// With no requested columns, expose only the intersection. This gives
		// callers a deterministic safe default without composing grants.
		all := true
		for _, scope := range eligible {
			if all {
				if scope.allColumns {
					continue
				}
				all = false
				for column := range scope.columns {
					policy.Columns[column] = struct{}{}
				}
				continue
			}
			if scope.allColumns {
				continue
			}
			for column := range policy.Columns {
				if _, ok := scope.columns[column]; !ok {
					delete(policy.Columns, column)
				}
			}
		}
		policy.AllColumns = all
	}
	allRows := false
	rowFilters := []Filter{}
	for _, scope := range eligible {
		if scope.allRows {
			allRows = true
			break
		}
		if scope.row != nil {
			rowFilters = append(rowFilters, *cloneFilter(scope.row))
		}
	}
	if !allRows {
		if len(rowFilters) == 0 {
			return Policy{}, Error(403, "row_forbidden", "授权未包含可访问的数据行")
		}
		if len(rowFilters) == 1 {
			policy.Row = &rowFilters[0]
		} else {
			policy.Row = &Filter{Logic: "or", Rules: rowFilters}
		}
	}
	return policy, nil
}

func ensurePolicyColumns(policy Policy, columns ...string) error {
	if policy.AllColumns {
		return nil
	}
	for _, col := range columns {
		if _, ok := policy.Columns[strings.ToLower(col)]; !ok {
			return Error(403, "column_forbidden", "没有字段操作权限")
		}
	}
	return nil
}

func combineFilters(filters []Filter, policy *Filter) *Filter {
	rules := make([]Filter, 0, len(filters)+1)
	rules = append(rules, filters...)
	if policy != nil {
		rules = append(rules, *cloneFilter(policy))
	}
	if len(rules) == 0 {
		return nil
	}
	if len(rules) == 1 {
		return &rules[0]
	}
	return &Filter{Logic: "and", Rules: rules}
}
