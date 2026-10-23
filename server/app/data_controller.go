package app

import (
	"context"

	"github.com/gogf/gf/v2/frame/g"
)

type DataController struct{ App *App }

type DatasetsAPIRequest struct {
	g.Meta `path:"/api/v1/datasets" method:"get" tags:"Data" summary:"List accessible business datasets"`
}
type DatasetsAPIResponse struct {
	Datasets []DatasetSummary `json:"datasets"`
}

type TablesAPIRequest struct {
	g.Meta    `path:"/api/v1/datasets/{datasetId}/tables" method:"get" tags:"Data" summary:"List permitted tables"`
	DatasetID string `json:"datasetId" in:"path"`
}
type TablesAPIResponse struct {
	Tables []string `json:"tables"`
}

type SchemaAPIRequest struct {
	g.Meta    `path:"/api/v1/datasets/{datasetId}/tables/{table}/schema" method:"get" tags:"Data" summary:"Read permitted table schema"`
	DatasetID string `json:"datasetId" in:"path"`
	Table     string `json:"table" in:"path"`
}
type SchemaAPIResponse struct {
	Fields []Field `json:"fields"`
}

type QueryAPIRequest struct {
	g.Meta     `path:"/api/v1/datasets/{datasetId}/tables/{table}/query" method:"post" tags:"Data" summary:"Run a structured query"`
	DatasetID  string      `json:"datasetId" in:"path"`
	Table      string      `json:"table" in:"path"`
	Fields     []string    `json:"fields,omitempty"`
	Filters    []Filter    `json:"filters,omitempty"`
	GroupBy    []string    `json:"groupBy,omitempty"`
	Aggregates []Aggregate `json:"aggregates,omitempty"`
	OrderBy    []Order     `json:"orderBy,omitempty"`
	Limit      int         `json:"limit,omitempty"`
	Offset     int         `json:"offset,omitempty"`
}

type MutateAPIRequest struct {
	g.Meta         `path:"/api/v1/datasets/{datasetId}/tables/{table}/records:mutate" method:"post" tags:"Data" summary:"Atomically mutate records"`
	DatasetID      string           `json:"datasetId" in:"path"`
	Table          string           `json:"table" in:"path"`
	IdempotencyKey string           `p:"Idempotency-Key" in:"header" json:"-"`
	Operations     []RecordMutation `json:"operations"`
}

type SchemaMutateAPIRequest struct {
	g.Meta         `path:"/api/v1/datasets/{datasetId}/schema:mutate" method:"post" tags:"Data" summary:"Atomically mutate table schema"`
	DatasetID      string            `json:"datasetId" in:"path"`
	IdempotencyKey string            `p:"Idempotency-Key" in:"header" json:"-"`
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

type ControlledSQLAPIRequest struct {
	g.Meta    `path:"/api/v1/datasets/{datasetId}/sql:query" method:"post" tags:"Data" summary:"Run the controlled SELECT subset"`
	DatasetID string         `json:"datasetId" in:"path"`
	SQL       string         `json:"sql"`
	Params    map[string]any `json:"params,omitempty"`
}

func (c *DataController) Tables(ctx context.Context, req *TablesAPIRequest) (*TablesAPIResponse, error) {
	tables, err := c.App.ListTables(ctx, req.DatasetID)
	if err != nil {
		return nil, err
	}
	return &TablesAPIResponse{Tables: tables}, nil
}
func (c *DataController) Datasets(ctx context.Context, req *DatasetsAPIRequest) (*DatasetsAPIResponse, error) {
	items, err := c.App.ListDatasets(ctx)
	if err != nil {
		return nil, err
	}
	return &DatasetsAPIResponse{Datasets: items}, nil
}
func (c *DataController) Schema(ctx context.Context, req *SchemaAPIRequest) (*SchemaAPIResponse, error) {
	fields, err := c.App.Schema(ctx, req.DatasetID, req.Table)
	if err != nil {
		return nil, err
	}
	return &SchemaAPIResponse{Fields: fields}, nil
}
func (c *DataController) Query(ctx context.Context, req *QueryAPIRequest) (*QueryResult, error) {
	result, err := c.App.Query(ctx, QueryRequest{DatasetID: req.DatasetID, Table: req.Table, Fields: req.Fields, Filters: req.Filters, GroupBy: req.GroupBy, Aggregates: req.Aggregates, OrderBy: req.OrderBy, Limit: req.Limit, Offset: req.Offset})
	if err != nil {
		return nil, err
	}
	return &result, nil
}
func (c *DataController) Mutate(ctx context.Context, req *MutateAPIRequest) (*MutationResult, error) {
	result, err := c.App.Mutate(ctx, MutationRequest{DatasetID: req.DatasetID, Table: req.Table, IdempotencyKey: requestIdempotencyKey(ctx, req.IdempotencyKey), Operations: req.Operations})
	if err != nil {
		return nil, err
	}
	return &result, nil
}
func (c *DataController) MutateSchema(ctx context.Context, req *SchemaMutateAPIRequest) (*SchemaMutationResult, error) {
	result, err := c.App.MutateSchema(ctx, SchemaMutationRequest{DatasetID: req.DatasetID, IdempotencyKey: requestIdempotencyKey(ctx, req.IdempotencyKey), Action: req.Action, Table: req.Table, Field: req.Field, Fields: req.Fields, PrimaryKey: req.PrimaryKey, UniqueKeys: req.UniqueKeys, Column: req.Column, NewName: req.NewName, NewType: req.NewType})
	if err != nil {
		return nil, err
	}
	return &result, nil
}
func (c *DataController) ControlledSQL(ctx context.Context, req *ControlledSQLAPIRequest) (*QueryResult, error) {
	result, err := c.App.QueryControlledSQL(ctx, ControlledSQLRequest{DatasetID: req.DatasetID, SQL: req.SQL, Params: req.Params})
	if err != nil {
		return nil, err
	}
	return &result, nil
}
