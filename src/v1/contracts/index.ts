import { z } from 'zod';
export const ErrorCode = z.enum([
  'VALIDATION_FAILED',
  'NOT_FOUND',
  'INVALID_TRANSITION',
  'VERSION_CONFLICT',
  'OPERATION_IN_PROGRESS',
  'IDEMPOTENCY_KEY_REUSED',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'INSUFFICIENT_SCOPE',
  'NOT_IMPLEMENTED',
  'INTERNAL_ERROR',
  'UNAVAILABLE',
  'METHOD_NOT_ALLOWED',
]);
export const ErrorEnvelope = z.object({
  error: z.object({
    code: ErrorCode,
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export const Actor = z.object({
  kind: z.enum(['access_user', 'oauth_client', 'service']),
  id: z.string().min(1),
  client_id: z.string().min(1),
  client_name: z.string().optional(),
  agent: z.string().trim().min(1).optional(),
});
export type Actor = z.infer<typeof Actor>;
const text = z.string().trim().min(1);
const instant = z.iso.datetime({ offset: true });
export const WaitingKind = z.enum(['human', 'agent', 'external', 'dependency']);
const summary = text.max(2000);
const actingAgent = text.optional().describe('Grok Bot bots should pass their own bot name; requires server authorization for the authenticated OAuth client cid.');
export const CompletionEvidence = z.object({
  kind: text,
  summary: text,
  source_ref: text.optional(),
});
export const ChecklistItem = z.object({
  id: text,
  position: z.number().int().nonnegative(),
  text,
  done: z.boolean(),
  done_at: instant.nullable(),
});
export const ChecklistInput = ChecklistItem.pick({
  text: true,
  done: true,
}).extend({ done: z.boolean().default(false) });
export const TaskFields = z.object({
  title: text,
  notes: z.string().default(''),
  area: z.enum(['private', 'work']).default('private'),
  project_key: text.nullable().default(null),
  status: z.enum(['todo', 'doing', 'waiting']).default('todo'),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  planned_start_at: instant.nullable().default(null),
  deadline_date: z.iso.date().nullable().default(null),
  deadline_at: instant.nullable().default(null),
  timezone: text.default('Asia/Tokyo'),
  estimate_minutes: z.number().int().nonnegative().nullable().default(null),
  definition_of_done: z.string().nullable().default(null),
  executor_kind: z.enum(['self', 'agent']).default('self'),
  assigned_agent: text.nullable().default(null),
  requester_ref: text.nullable().default(null),
  source_ref: text.nullable().default(null),
  context_refs: z.array(text).default([]),
});
export const Task = TaskFields.extend({
  accepted_at: instant.nullable().default(null),
  waiting_kind: WaitingKind.nullable().default(null),
  waiting_on_ref: text.nullable().default(null),
  blocker_summary: summary.nullable().default(null),
  next_check_at: instant.nullable().default(null),
  next_check_by: text.nullable().default(null),
  id: text,
  owner_id: text,
  version: z.number().int().min(1),
  status: z.enum(['todo', 'doing', 'waiting', 'done', 'cancelled']),
  completed_at: instant.nullable(),
  completion_evidence: CompletionEvidence.nullable(),
  cancel_reason: z.string().nullable(),
  series_id: text.nullable(),
  occurrence_key: text.nullable(),
  legacy_issue_number: z.number().int().nullable(),
  created_at: instant,
  updated_at: instant,
  archived_at: instant.nullable(),
  checklist: z.array(ChecklistItem),
}).refine((t) => !t.deadline_date || !t.deadline_at, {
  message: 'deadline_date and deadline_at are mutually exclusive',
}).refine(t => t.priority !== 'urgent' || t.executor_kind === 'agent', {
  message: 'urgent requires executor_kind=agent',
});
export type Task = z.infer<typeof Task>;
const request = z.object({ request_id: text });
const target = z.object({ id: text });
const mutation = request.extend({
  id: text,
  expected_version: z.number().int().min(1),
});
export const ListParams = z.object({
  status: z.enum(['todo', 'doing', 'waiting', 'done', 'cancelled']).optional(),
  area: z.enum(['private', 'work']).optional(),
  project_key: text.optional(),
  executor_kind: z.enum(['self', 'agent']).optional(),
  assigned_agent: text.optional(),
  waiting_kind: WaitingKind.optional(),
  next_check_before: instant.optional(),
  unaccepted: z.union([z.boolean(), z.enum(['true', 'false']).transform(v => v === 'true')]).optional(),
  due_from: z.iso.date().optional(),
  due_to: z.iso.date().optional(),
  cursor: text.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export const ListOutput = z.object({
  items: z.array(Task),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
  coverage_incomplete: z.boolean(),
});
export const Event = z.object({
  id: z.number().int(),
  task_id: text,
  owner_id: text,
  operation_request_id: text,
  type: z.enum([
    'created',
    'updated',
    'completed',
    'reopened',
    'cancelled',
    'occurrence_skipped',
  ]),
  actor: Actor,
  task_version: z.number().int(),
  payload: z.unknown(),
  created_at: instant,
});
export const Operation = z.object({
  owner_id: text,
  client_id: text,
  request_id: text,
  op: text,
  input_hash: text,
  status: z.enum(['pending', 'committed']),
  actor: Actor,
  response_json: z.unknown().nullable(),
  task_id: text.nullable(),
  created_at: instant,
});
const patchFields = z.object(
  Object.fromEntries(
    Object.entries(TaskFields.omit({ assigned_agent: true }).shape).map(([key, schema]) => [
      key,
      schema instanceof z.ZodDefault ? schema.removeDefault() : schema,
    ]),
  ),
);
const patch = patchFields
  .partial()
  .extend({ checklist: z.array(ChecklistInput).optional() })
  .strict();
export const RuleFields = z
  .object({
    template: TaskFields.pick({
      title: true,
      notes: true,
      area: true,
      project_key: true,
      priority: true,
      estimate_minutes: true,
      definition_of_done: true,
      executor_kind: true,
      context_refs: true,
    })
      .extend({
        priority: z.enum(['low', 'normal', 'high']).default('normal'),
        checklist: z.array(ChecklistInput).default([]),
        start_time: z
          .string()
          .regex(/^([01]\d|2[0-3]):[0-5]\d$/u)
          .optional(),
      })
      .strict(),
    kind: z.enum(['daily', 'weekdays', 'weekly', 'monthly']),
    weekdays: z
      .array(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']))
      .min(1)
      .optional(),
    month_day: z.number().int().min(1).max(31).optional(),
    starts_on: z.iso.date(),
    ends_on: z.iso.date().nullable().default(null),
    timezone: z
      .string()
      .default('Asia/Tokyo')
      .refine((v) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: v });
          return true;
        } catch {
          return false;
        }
      }, 'Invalid IANA timezone'),
  })
  .strict()
  .refine(
    (r) =>
      (!r.ends_on || r.ends_on >= r.starts_on) &&
      (r.kind !== 'weekly' || !!r.weekdays?.length) &&
      (r.kind !== 'monthly' || !!r.month_day),
    'Invalid recurrence range or kind fields',
  );
export const RecurrenceRule = RuleFields.extend({
  id: text,
  owner_id: text,
  version: z.number().int().min(1),
  status: z.enum(['active', 'ended']),
  created_at: instant,
  updated_at: instant,
});
export type RecurrenceRule = z.infer<typeof RecurrenceRule>;
export const RuleUpdate = z.object({
  previous_rule: RecurrenceRule,
  rule: RecurrenceRule,
});
export const RuleList = z.object({
  items: z.array(RecurrenceRule),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
  coverage_incomplete: z.boolean(),
});
export const Progress = z.object({
  id: text, task_id: text, owner_id: text, client_id: text, request_id: text,
  actor: Actor, reported_agent: text, attribution: z.enum(['self', 'proxy', 'system']),
  summary, source_ref: text.nullable(), created_at: instant,
});
export type Progress = z.infer<typeof Progress>;
export const ProgressList = z.object({
  items: z.array(Progress), next_cursor: z.string().nullable(), has_more: z.boolean(),
});
export const AgentWorkList = z.object({
  enabled: z.boolean(),
  items: z.array(Task.and(z.object({ latest_progress: Progress.nullable() }))),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});
export const inputs = {
  list_agent_work: z.object({
    cursor: text.optional(), limit: z.coerce.number().int().min(1).max(100).default(50),
  }).strict(),
  claim: mutation.extend({ acting_agent: actingAgent, assigned_agent: text.optional() }).strict()
    .refine(p => !!p.assigned_agent || !!p.acting_agent, 'Claim requires assigned_agent or acting_agent'),
  log_progress: request.extend({
    acting_agent: actingAgent, id: text, summary, source_ref: text.nullable().default(null),
    reported_agent: text.optional(), attribution: z.enum(['self', 'proxy']).default('self'),
  }).strict().refine(p => p.attribution !== 'proxy' || !!p.reported_agent, 'Proxy reports require reported_agent'),
  set_waiting: mutation.extend({
    acting_agent: actingAgent,
    waiting_kind: WaitingKind, waiting_on_ref: text, blocker_summary: summary,
    next_check_at: instant, next_check_by: text,
  }).strict(),
  handoff: mutation.extend({
    acting_agent: actingAgent,
    assigned_agent: text, reason: summary, next_check_by: text,
    next_check_at: instant.nullable().default(null),
    wake_now: z.boolean().optional(),
  }).strict(),
  list_progress: target.extend({
    cursor: text.optional(), limit: z.coerce.number().int().min(1).max(100).default(20),
  }).strict(),
  create: request.extend({
    acting_agent: actingAgent,
    wake_now: z.boolean().optional(),
    task: TaskFields.extend({
      checklist: z.array(ChecklistInput).default([]),
    }).strict(),
  }),
  get: target,
  list: ListParams,
  update: mutation.extend({ patch }),
  complete: mutation.extend({ acting_agent: actingAgent, evidence: CompletionEvidence }),
  reopen: mutation,
  cancel: mutation.extend({ reason: text }),
  skip_occurrence: mutation.extend({ reason: text }),
  get_changes: z.object({
    since: text.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  }),
  get_operation: z.object({ request_id: text }),
  list_recurrence_rules: z.object({
    status: z.enum(['active', 'ended']).optional(),
    cursor: text.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  }),
  get_recurrence_rule: target,
  create_recurrence_rule: request.extend({
    rule: RuleFields,
  }),
  update_recurrence_rule: mutation.extend({
    rule: RuleFields,
  }),
  delete_recurrence_rule: mutation,
};
const changes = z.object({
  items: z.array(Event),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
});
const definitions = [
  ['list', 'GET', '/api/v1/tasks', 'read', ListOutput],
  ['get', 'GET', '/api/v1/tasks/{id}', 'read', Task],
  ['create', 'POST', '/api/v1/tasks', 'write', Task],
  ['update', 'PATCH', '/api/v1/tasks/{id}', 'write', Task],
  ['complete', 'POST', '/api/v1/tasks/{id}/complete', 'write', Task],
  ['reopen', 'POST', '/api/v1/tasks/{id}/reopen', 'write', Task],
  ['cancel', 'POST', '/api/v1/tasks/{id}/cancel', 'write', Task],
  ['skip_occurrence', 'POST', '/api/v1/tasks/{id}/skip', 'write', Task],
  ['get_changes', 'GET', '/api/v1/changes', 'read', changes],
  [
    'get_operation',
    'GET',
    '/api/v1/operations/{request_id}',
    'read',
    Operation,
  ],
  [
    'list_recurrence_rules',
    'GET',
    '/api/v1/recurrence-rules',
    'read',
    RuleList,
  ],
  [
    'get_recurrence_rule',
    'GET',
    '/api/v1/recurrence-rules/{id}',
    'read',
    RecurrenceRule,
  ],
  [
    'create_recurrence_rule',
    'POST',
    '/api/v1/recurrence-rules',
    'write',
    RecurrenceRule,
  ],
  [
    'update_recurrence_rule',
    'PATCH',
    '/api/v1/recurrence-rules/{id}',
    'write',
    RuleUpdate,
  ],
  [
    'delete_recurrence_rule',
    'DELETE',
    '/api/v1/recurrence-rules/{id}',
    'write',
    RecurrenceRule,
  ],
] as const;
const descriptions: Record<keyof typeof inputs, string> = {
  list_agent_work: 'Read active one-off AI work with latest progress and feature availability for the read-only web tab.',
  claim: 'Accept an assigned AI task and start doing it.',
  log_progress: 'Append an AI progress report without changing task state or version.',
  set_waiting: 'Record what an AI task is waiting on and who checks it next.',
  handoff: 'Reassign AI work with a reason and next check owner; acceptance is reset.',
  list_progress: 'Read the owner-scoped append-only AI progress history.',
  list: 'List tasks with status, area, project_key, due_from/due_to, executor_kind, assigned_agent, waiting_kind, next_check_before and unaccepted filters and cursor pagination (limit 1–100).',
  get: 'Get a task and its checklist. Requires id.',
  create:
    'Create a task. Requires request_id and task.title; optional task fields and checklist are supported. Passing planned time is never completion.',
  update:
    'Patch an active task. Requires id, request_id, expected_version and patch. Reopen terminal tasks first. Passing planned time is never completion.',
  complete:
    'Complete an active task with required evidence {kind, summary, source_ref?}. Requires id, request_id and expected_version. Passing planned time is never completion.',
  reopen:
    'Reopen a done or cancelled task to todo, clearing completion and cancellation details. Requires id, request_id and expected_version.',
  cancel:
    'Cancel an active task. Requires id, request_id, expected_version and reason.',
  skip_occurrence:
    'Skip an active recurring occurrence by cancelling it. Requires series membership, id, request_id, expected_version and reason.',
  get_changes:
    'Read the owner’s task event stream with optional since cursor and limit (1–100).',
  get_operation:
    'Look up a committed operation for this client using request_id; use it to resolve uncertain write results.',
  list_recurrence_rules: 'List recurrence rules.',
  get_recurrence_rule: 'Get a recurrence rule by id.',
  create_recurrence_rule: 'Create a recurrence rule with request_id and rule.',
  update_recurrence_rule:
    'Update a recurrence rule with id, request_id, expected_version and rule.',
  delete_recurrence_rule:
    'End a recurrence rule with id, request_id and expected_version.',
};
const existingRegistry = definitions.map(
  ([name, method, path, scope, outputSchema]) => ({
    name,
    toolName: `taskflow_${name}`,
    description: descriptions[name] + (['create', 'claim', 'log_progress', 'set_waiting', 'handoff', 'complete'].includes(name) ? ' Grok Bot bots should pass their own bot name in acting_agent (requires a server-side OAuth cid allowlist). reported_agent is the subject of a progress report, not the acting identity.' : ''),
    inputSchema: inputs[name],
    outputSchema,
    scope,
    method,
    path,
  }),
);
export const agentWorkRegistry = ([
  ['claim', 'POST', '/api/v1/tasks/{id}/claim', 'write', Task],
  ['log_progress', 'POST', '/api/v1/tasks/{id}/progress', 'write', Progress],
  ['set_waiting', 'POST', '/api/v1/tasks/{id}/waiting', 'write', Task],
  ['handoff', 'POST', '/api/v1/tasks/{id}/handoff', 'write', Task],
  ['list_progress', 'GET', '/api/v1/tasks/{id}/progress', 'read', ProgressList],
] as const).map(([name, method, path, scope, outputSchema]) => ({
  name, toolName: `taskflow_${name}`, description: descriptions[name] + (['create', 'claim', 'log_progress', 'set_waiting', 'handoff', 'complete'].includes(name) ? ' Grok Bot bots should pass their own bot name in acting_agent (requires a server-side OAuth cid allowlist). reported_agent is the subject of a progress report, not the acting identity.' : ''),
  inputSchema: inputs[name], outputSchema, scope, method, path,
}));
export const opRegistry = [...existingRegistry, ...agentWorkRegistry];
// The read-only web projection is intentionally not an MCP tool.
export const httpRegistry = [...opRegistry, {
  name: 'list_agent_work' as const,
  toolName: 'taskflow_list_agent_work',
  description: descriptions.list_agent_work,
  inputSchema: inputs.list_agent_work,
  outputSchema: AgentWorkList,
  scope: 'read' as const,
  method: 'GET' as const,
  path: '/api/v1/agent-work',
}];
export function generateOpenApi() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of httpRegistry) {
    const schema = z.toJSONSchema(op.inputSchema, {
      target: 'openapi-3.0',
      io: 'input',
    });
    const properties = (
      'properties' in schema ? schema.properties : {}
    ) as Record<string, unknown>;
    const required = ('required' in schema ? schema.required : []) as string[];
    const parameters = Object.entries(properties)
      .filter(([key]) => op.path.includes(`{${key}}`) || op.method === 'GET')
      .map(([name, schema]) => ({
        name,
        in: op.path.includes(`{${name}}`) ? 'path' : 'query',
        required: op.path.includes(`{${name}}`) || required.includes(name),
        schema,
      }));
    (paths[op.path] ??= {})[op.method.toLowerCase()] = {
      operationId: op.toolName,
      description: op.description,
      parameters,
      ...(op.method === 'GET'
        ? {}
        : {
            requestBody: {
              required: true,
              content: { 'application/json': { schema } },
            },
          }),
      responses: {
        200: {
          description: 'Success',
          content: {
            'application/json': {
              schema: z.toJSONSchema(op.outputSchema, {
                target: 'openapi-3.0',
              }),
            },
          },
        },
        default: {
          description: 'Error',
          content: {
            'application/json': {
              schema: z.toJSONSchema(ErrorEnvelope, { target: 'openapi-3.0' }),
            },
          },
        },
      },
    };
  }
  return {
    openapi: '3.0.3',
    info: { title: 'TaskFlow v1', version: '1.0.0' },
    paths,
  };
}
