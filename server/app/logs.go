package app

import (
	"context"
	"time"

	"github.com/gogf/gf/v2/frame/g"
)

type QueryLogsReq struct {
	g.Meta    `path:"/api/v1/query-logs" method:"get" tags:"运行状态" summary:"查询模板及执行来源日志，不含参数值"`
	DatasetID string `json:"datasetId" in:"query"`
	Limit     int    `json:"limit" in:"query"`
	Offset    int    `json:"offset" in:"query"`
}
type QueryLog struct {
	ID          string    `json:"id"`
	CreatedAt   time.Time `json:"createdAt"`
	ActorID     string    `json:"actorId"`
	DatasetID   string    `json:"datasetId"`
	Table       string    `json:"table"`
	Source      string    `json:"source"`
	Kind        string    `json:"kind"`
	SQLTemplate string    `json:"sqlTemplate"`
	Outcome     string    `json:"outcome"`
	DurationMS  int64     `json:"durationMs"`
	RequestID   string    `json:"requestId"`
}
type QueryLogsRes struct {
	Items []QueryLog `json:"items"`
}

func (c *ConfigController) QueryLogs(ctx context.Context, r *QueryLogsReq) (*QueryLogsRes, error) {
	if _, err := Require(ctx, "logs.read"); err != nil {
		return nil, err
	}
	if r.Limit <= 0 {
		r.Limit = 100
	}
	if r.Limit > 1000 || r.Offset < 0 {
		return nil, Error(400, "invalid_page", "分页参数无效")
	}
	rows, err := c.App.DB.QueryContext(ctx, `SELECT id,created_at,actor_id,dataset_id,table_name,source,query_kind,sql_template,outcome,duration_ms,request_id FROM query_logs WHERE (?='' OR dataset_id=?) ORDER BY created_at DESC LIMIT ? OFFSET ?`, r.DatasetID, r.DatasetID, r.Limit, r.Offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	res := &QueryLogsRes{Items: []QueryLog{}}
	for rows.Next() {
		var q QueryLog
		if err = rows.Scan(&q.ID, &q.CreatedAt, &q.ActorID, &q.DatasetID, &q.Table, &q.Source, &q.Kind, &q.SQLTemplate, &q.Outcome, &q.DurationMS, &q.RequestID); err != nil {
			return nil, err
		}
		res.Items = append(res.Items, q)
	}
	return res, rows.Err()
}

type ClientEventReq struct {
	g.Meta     `path:"/api/v1/client-events" method:"post" tags:"运行状态" summary:"幂等补报客户端导出或中转事件"`
	EventID    string `json:"eventId" v:"required"`
	InstanceID string `json:"instanceId" v:"required"`
	OccurredAt string `json:"occurredAt" v:"required"`
	Category   string `json:"category" v:"required"`
	Action     string `json:"action" v:"required"`
	TargetID   string `json:"targetId"`
	Outcome    string `json:"outcome" v:"required"`
}
type ClientEventRes struct{ ClientEventReceipt }

func (c *ConfigController) ClientEvent(ctx context.Context, r *ClientEventReq) (*ClientEventRes, error) {
	u := CurrentUser(ctx)
	if u == nil {
		return nil, Error(401, "unauthenticated", "请先登录")
	}
	receipt, err := c.App.AcceptClientEvent(ctx, u, ClientEventInput{
		EventID: r.EventID, InstanceID: r.InstanceID, OccurredAt: r.OccurredAt,
		Category: r.Category, Action: r.Action, TargetID: r.TargetID, Outcome: r.Outcome,
	})
	if err != nil {
		return nil, safePublicError(err, "接收客户端事件失败")
	}
	return &ClientEventRes{ClientEventReceipt: receipt}, nil
}

type ListClientEventsReq struct {
	g.Meta   `path:"/api/v1/client-events" method:"get" tags:"运行状态" summary:"检索客户端补报事件"`
	Category string `json:"category" in:"query"`
	TargetID string `json:"targetId" in:"query"`
	Limit    int    `json:"limit" in:"query"`
	Offset   int    `json:"offset" in:"query"`
}
type ClientEventRecord struct {
	EventID    string    `json:"eventId"`
	InstanceID string    `json:"instanceId"`
	ActorID    string    `json:"actorId"`
	Category   string    `json:"category"`
	Action     string    `json:"action"`
	TargetID   string    `json:"targetId"`
	Outcome    string    `json:"outcome"`
	OccurredAt time.Time `json:"occurredAt"`
	ReceivedAt time.Time `json:"receivedAt"`
	Applied    bool      `json:"applied"`
}
type ListClientEventsRes struct {
	Items []ClientEventRecord `json:"items"`
}

func (c *ConfigController) ListClientEvents(ctx context.Context, r *ListClientEventsReq) (*ListClientEventsRes, error) {
	if _, err := Require(ctx, "logs.read"); err != nil {
		return nil, err
	}
	if r.Limit <= 0 {
		r.Limit = 100
	}
	if r.Limit > 1000 || r.Offset < 0 || len(r.Category) > 32 || len(r.TargetID) > 100 {
		return nil, Error(400, "invalid_page", "客户端事件查询参数无效")
	}
	rows, err := c.App.DB.QueryContext(ctx, `SELECT event_id,instance_id,actor_id,category,action,target_id,outcome,occurred_at,received_at,applied FROM client_events WHERE (?='' OR category=?) AND (?='' OR target_id=?) ORDER BY received_at DESC,actor_id,event_id LIMIT ? OFFSET ?`,
		r.Category, r.Category, r.TargetID, r.TargetID, r.Limit, r.Offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := &ListClientEventsRes{Items: []ClientEventRecord{}}
	for rows.Next() {
		var item ClientEventRecord
		var occurredRaw string
		if err = rows.Scan(&item.EventID, &item.InstanceID, &item.ActorID, &item.Category, &item.Action, &item.TargetID, &item.Outcome, &occurredRaw, &item.ReceivedAt, &item.Applied); err != nil {
			return nil, err
		}
		item.OccurredAt, err = time.Parse(time.RFC3339Nano, occurredRaw)
		if err != nil {
			return nil, Error(500, "invalid_client_event_record", "客户端事件记录无效")
		}
		result.Items = append(result.Items, item)
	}
	return result, rows.Err()
}
