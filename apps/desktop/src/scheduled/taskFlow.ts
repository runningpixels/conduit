/// The steps that make a task, shared by the task dialog and the chat's confirm card so both do the
/// same thing: save it (its schedule is left off), show what it may do when nobody is watching, and
/// once that is approved turn the schedule on. A task that needs no approval is turned on at once.

import {
  approveWorkflowPermissions,
  createRoutine,
  setWorkflowSchedule,
  updateRoutine,
} from '../ipc/client';
import type { RoutineCreated, RoutineRequest, ScheduleSpec, WorkflowSchedule } from '../ipc/contracts';

/// Make a task from `request`, or rewrite `editing`; the schedule is off until `turnOnTask`.
export function saveTask(request: RoutineRequest, editing?: string | null): Promise<RoutineCreated> {
  return editing ? updateRoutine(editing, request) : createRoutine(request);
}

/// Whether `saved` waits for the user to approve what it may do before it can be turned on.
export function needsApproval(saved: RoutineCreated): boolean {
  return saved.permissions.missing.length > 0;
}

/// Switch the task's schedule on; the result says when it runs next.
export async function turnOnTask(workflowId: string, schedule: ScheduleSpec): Promise<WorkflowSchedule | null> {
  return setWorkflowSchedule(workflowId, schedule, true);
}

/// Approve what the task may do, then switch its schedule on.
export async function approveAndTurnOn(workflowId: string, schedule: ScheduleSpec): Promise<WorkflowSchedule | null> {
  await approveWorkflowPermissions(workflowId);
  return turnOnTask(workflowId, schedule);
}
