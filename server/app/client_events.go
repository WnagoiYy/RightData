package app

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

var clientEventUUID = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)

type ClientEventInput struct {
	EventID    string
	InstanceID string
	OccurredAt string
	Category   string
	Action     string
	TargetID   string
	Outcome    string
}

type ClientEventReceipt struct {
	EventID    string    `json:"eventId"`
	ReceivedAt time.Time `json:"receivedAt"`
	Applied    bool      `json:"applied"`
}

type ClientReport struct {
	EventID    string     `json:"eventId,omitempty"`
	Stage      string     `json:"stage"`
	Outcome    string     `json:"outcome"`
	OccurredAt *time.Time `json:"occurredAt,omitempty"`
	ReceivedAt *time.Time `json:"receivedAt,omitempty"`
}

type clientEventFingerprint struct {
	InstanceID string `json:"instanceId"`
	OccurredAt string `json:"occurredAt"`
	Category   string `json:"category"`
	Action     string `json:"action"`
	TargetID   string `json:"targetId"`
	Outcome    string `json:"outcome"`
}

func validateClientEventInput(instanceID string, input ClientEventInput) (ClientEventInput, time.Time, string, error) {
	input.EventID = strings.ToLower(input.EventID)
	if !clientEventUUID.MatchString(input.EventID) {
		return input, time.Time{}, "", Error(400, "invalid_event_id", "eventId 必须是规范 UUID")
	}
	if input.InstanceID == "" || len(input.InstanceID) > 128 || input.InstanceID != instanceID {
		return input, time.Time{}, "", Error(409, "instance_mismatch", "事件不属于当前服务实例")
	}
	if !utf8.ValidString(input.TargetID) || len(input.TargetID) > 100 {
		return input, time.Time{}, "", Error(400, "invalid_event_target", "事件目标无效")
	}
	if len(input.OccurredAt) > 64 || len(input.Category) > 32 || len(input.Action) > 64 || len(input.Outcome) > 16 {
		return input, time.Time{}, "", Error(400, "invalid_client_event", "客户端事件字段长度无效")
	}
	occurredAt, err := time.Parse(time.RFC3339Nano, input.OccurredAt)
	if err != nil {
		return input, time.Time{}, "", Error(400, "invalid_occurred_at", "occurredAt 必须是 RFC3339 时间")
	}
	occurredAt = occurredAt.UTC()
	switch input.Category {
	case "client_export":
		if input.Action != "file_generation" || strings.TrimSpace(input.TargetID) == "" {
			return input, time.Time{}, "", Error(400, "invalid_client_event", "客户端导出事件类型或目标无效")
		}
	case "relay":
		if input.Action != "connect" && input.Action != "disconnect" {
			return input, time.Time{}, "", Error(400, "invalid_client_event", "中转事件类型无效")
		}
	default:
		return input, time.Time{}, "", Error(400, "invalid_client_event", "不支持的客户端事件类别")
	}
	if input.Outcome != "success" && input.Outcome != "failed" && input.Outcome != "canceled" {
		return input, time.Time{}, "", Error(400, "invalid_client_event", "不支持的客户端事件结果")
	}
	fingerprintBody, _ := json.Marshal(clientEventFingerprint{
		InstanceID: input.InstanceID,
		OccurredAt: occurredAt.Format(time.RFC3339Nano),
		Category:   input.Category,
		Action:     input.Action,
		TargetID:   input.TargetID,
		Outcome:    input.Outcome,
	})
	digest := sha256.Sum256(fingerprintBody)
	return input, occurredAt, hex.EncodeToString(digest[:]), nil
}

func (a *App) AcceptClientEvent(ctx context.Context, user *User, input ClientEventInput) (ClientEventReceipt, error) {
	if user == nil || user.Disabled {
		return ClientEventReceipt{}, Error(401, "unauthenticated", "请先登录")
	}
	input, occurredAt, fingerprint, err := validateClientEventInput(a.InstanceID, input)
	if err != nil {
		return ClientEventReceipt{}, err
	}
	tx, err := a.DB.BeginTx(ctx, nil)
	if err != nil {
		return ClientEventReceipt{}, err
	}
	defer tx.Rollback()

	var existingFingerprint string
	var receipt ClientEventReceipt
	err = tx.QueryRowContext(ctx, `SELECT fingerprint,received_at,applied FROM client_events WHERE actor_id=? AND event_id=?`, user.ID, input.EventID).
		Scan(&existingFingerprint, &receipt.ReceivedAt, &receipt.Applied)
	if err == nil {
		if existingFingerprint != fingerprint {
			return ClientEventReceipt{}, Error(409, "event_id_conflict", "eventId 已用于不同的事件内容")
		}
		receipt.EventID = input.EventID
		return receipt, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return ClientEventReceipt{}, err
	}

	applied := true
	if input.Category == "client_export" {
		var ownerID, kind string
		err = tx.QueryRowContext(ctx, `SELECT actor_id,kind FROM jobs WHERE id=?`, input.TargetID).Scan(&ownerID, &kind)
		if errors.Is(err, sql.ErrNoRows) {
			return ClientEventReceipt{}, Error(404, "job_not_found", "导出任务不存在")
		}
		if err != nil {
			return ClientEventReceipt{}, err
		}
		if ownerID != user.ID {
			return ClientEventReceipt{}, Error(403, "forbidden", "不能补报其他用户的导出事件")
		}
		if kind != "export" {
			return ClientEventReceipt{}, Error(409, "invalid_event_target", "客户端导出事件必须关联导出任务")
		}
		var latestEventID string
		var latestOccurredRaw string
		err = tx.QueryRowContext(ctx, `SELECT event_id,occurred_at FROM client_event_latest WHERE actor_id=? AND target_id=? AND stage=?`, user.ID, input.TargetID, input.Action).
			Scan(&latestEventID, &latestOccurredRaw)
		if err == nil {
			latestOccurredAt, parseErr := time.Parse(time.RFC3339Nano, latestOccurredRaw)
			if parseErr != nil {
				return ClientEventReceipt{}, Error(500, "invalid_client_event_record", "客户端事件记录无效")
			}
			applied = occurredAt.After(latestOccurredAt) || occurredAt.Equal(latestOccurredAt) && input.EventID > latestEventID
		} else if !errors.Is(err, sql.ErrNoRows) {
			return ClientEventReceipt{}, err
		}
	}

	receivedAt := time.Now().UTC().Truncate(time.Microsecond)
	auditID := NewID()
	_, err = tx.ExecContext(ctx, `INSERT INTO client_events(actor_id,event_id,fingerprint,instance_id,category,action,target_id,outcome,occurred_at,received_at,applied,audit_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
		user.ID, input.EventID, fingerprint, input.InstanceID, input.Category, input.Action, input.TargetID, input.Outcome, occurredAt.Format(time.RFC3339Nano), receivedAt, applied, auditID)
	if err != nil {
		return ClientEventReceipt{}, err
	}
	if input.Category == "client_export" && applied {
		_, err = tx.ExecContext(ctx, `INSERT INTO client_event_latest(actor_id,target_id,stage,event_id,occurred_at) VALUES(?,?,?,?,?) ON CONFLICT(actor_id,target_id,stage) DO UPDATE SET event_id=excluded.event_id,occurred_at=excluded.occurred_at`,
			user.ID, input.TargetID, input.Action, input.EventID, occurredAt.Format(time.RFC3339Nano))
		if err != nil {
			return ClientEventReceipt{}, err
		}
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO audit(id,created_at,actor_id,category,action,target,outcome,duration_ms,request_id) VALUES(?,?,?,?,?,?,?,?,?)`,
		auditID, receivedAt, user.ID, input.Category, input.Action, input.TargetID, input.Outcome, 0, RequestID(ctx))
	if err != nil {
		return ClientEventReceipt{}, err
	}
	if err = tx.Commit(); err != nil {
		return ClientEventReceipt{}, err
	}
	return ClientEventReceipt{EventID: input.EventID, ReceivedAt: receivedAt, Applied: applied}, nil
}

func (a *App) ClientReportForJob(ctx context.Context, actorID, jobID string) (*ClientReport, error) {
	report := &ClientReport{Stage: "file_generation", Outcome: "unknown"}
	var occurredRaw string
	var receivedAt time.Time
	err := a.DB.QueryRowContext(ctx, `SELECT e.event_id,e.outcome,e.occurred_at,e.received_at FROM client_event_latest l JOIN client_events e ON e.actor_id=l.actor_id AND e.event_id=l.event_id WHERE l.actor_id=? AND l.target_id=? AND l.stage='file_generation'`, actorID, jobID).
		Scan(&report.EventID, &report.Outcome, &occurredRaw, &receivedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return report, nil
	}
	if err != nil {
		return nil, err
	}
	occurredAt, err := time.Parse(time.RFC3339Nano, occurredRaw)
	if err != nil {
		return nil, Error(500, "invalid_client_event_record", "客户端事件记录无效")
	}
	report.OccurredAt = &occurredAt
	report.ReceivedAt = &receivedAt
	return report, nil
}
