package schema

import (
	"entgo.io/ent"
	"entgo.io/ent/schema/field"
	"entgo.io/ent/schema/index"
)

type Task struct{ ent.Schema }

func (Task) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").NotEmpty().Immutable(),
		field.String("payload_hash").NotEmpty().Immutable(),
		field.String("kind").NotEmpty().Immutable(),
		field.Bytes("payload").Immutable(),
		field.Int64("binding_epoch").Positive().Immutable(),
		field.Enum("status").Values("accepted", "running", "succeeded", "failed").Default("accepted"),
		field.Int64("progress_seq").NonNegative().Default(0),
		field.Bytes("result").Optional(),
		field.Bool("acknowledged").Default(false),
	}
}

type Cursor struct{ ent.Schema }

func (Cursor) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").NotEmpty().Immutable(),
		field.String("runtime_id").NotEmpty(),
		field.Int64("upload").NonNegative(), field.Int64("download").NonNegative(),
		field.Int64("observed_at"),
		field.Bool("closed").Default(false),
	}
}

type Stream struct{ ent.Schema }

func (Stream) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").NotEmpty().Immutable(),
		field.Int64("next_seq").Positive().Default(1),
		field.Int64("committed_seq").NonNegative().Default(0),
		field.Int64("pending_bytes").NonNegative().Default(0),
		field.String("recovery_issue").Default(""),
	}
}

type Batch struct{ ent.Schema }

func (Batch) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").NotEmpty().Immutable(), field.Int64("seq").Positive().Immutable(),
		field.String("stream_id").NotEmpty().Immutable(),
		field.Int64("size_bytes").NonNegative().Default(0).Immutable(),
		field.Bytes("payload").Immutable(),
		field.String("payload_hash").NotEmpty().Immutable(),
	}
}

func (Batch) Indexes() []ent.Index { return []ent.Index{index.Fields("stream_id", "seq").Unique()} }

type Core struct{ ent.Schema }

func (Core) Fields() []ent.Field {
	return []ent.Field{
		field.String("id").NotEmpty().Immutable(),
		field.Int64("policy_floor").NonNegative().Default(0),
		field.Bytes("authorization").Optional(),
		field.String("applied_revision").Default(""),
		field.Int64("applied_policy").NonNegative().Default(0),
		field.Bytes("applied_config").Optional(),
		field.String("stage").Default("idle"),
		field.String("pending_task").Default(""),
		field.String("pending_revision").Default(""),
		field.Int64("pending_policy").NonNegative().Default(0),
		field.Bytes("pending_config").Optional(),
	}
}
