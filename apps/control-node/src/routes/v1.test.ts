import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  test("control-node integration tests require DATABASE_URL", { skip: true }, () => {});
} else {
  process.env.NODE_ENV = "test";
  process.env.CONTROL_NODE_TLS_ENABLED = "false";
  process.env.DATABASE_URL = databaseUrl;

  const [{ buildServer }, { prisma }] = await Promise.all([import("../server.js"), import("../lib/prisma.js")]);
  let app = await buildServer();

  const baseMachine = {
    hostname: "integration-demo-host",
    os: "macos 15.0",
    architecture: "arm64",
  };

  const enrollRunner = async (runnerName: string) => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/enroll",
      payload: {
        runnerName,
        labels: ["demo", "backend"],
        environment: "demo",
        machine: {
          ...baseMachine,
          hostname: `${baseMachine.hostname}-${runnerName}`,
        },
      },
    });

    assert.equal(response.statusCode, 200);
    return response.json() as {
      runner: {
        id: string;
        name: string;
        labels: string[];
        environment: string | null;
      };
      credentials: {
        token: string;
      };
    };
  };

  const postTelemetry = async (token: string, events: unknown[]) => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/telemetry",
      headers: {
        authorization: `Bearer ${token}`,
      },
      payload: { events },
    });

    assert.equal(response.statusCode, 200);
  };

  beforeEach(async () => {
    await prisma.telemetryEvent.deleteMany();
    await prisma.agentSession.deleteMany();
    await prisma.runnerToken.deleteMany();
    await prisma.runner.deleteMany();
    await prisma.machine.deleteMany();
  });

  after(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  test("enrolls runners, tracks heartbeats, and filters runners by status and label", async () => {
    const enrollment = await enrollRunner("backend-runner-online");

    assert.deepEqual(enrollment.runner.labels, ["demo", "backend"]);
    assert.equal(enrollment.runner.environment, "demo");

    const heartbeatResponse = await app.inject({
      method: "POST",
      url: "/v1/heartbeat",
      headers: {
        authorization: `Bearer ${enrollment.credentials.token}`,
      },
      payload: {
        timestamp: "2026-04-02T20:00:00.000Z",
        activeSessionCount: 0,
        metadata: {
          mode: "test",
        },
      },
    });

    assert.equal(heartbeatResponse.statusCode, 200);

    const runnersResponse = await app.inject({
      method: "GET",
      url: "/v1/runners?status=online&label=demo&search=backend-runner-online",
    });

    assert.equal(runnersResponse.statusCode, 200);
    const runners = runnersResponse.json() as Array<{
      id: string;
      name: string;
      status: string;
      labels: string[];
      environment: string | null;
      activeSessionCount: number;
    }>;

    assert.equal(runners.length, 1);
    assert.equal(runners[0]?.id, enrollment.runner.id);
    assert.equal(runners[0]?.status, "online");
    assert.equal(runners[0]?.environment, "demo");
    assert.deepEqual(runners[0]?.labels, ["demo", "backend"]);
    assert.equal(runners[0]?.activeSessionCount, 0);
  });

  test("creates completed and failed sessions and exposes filterable sessions and events", async () => {
    const enrollment = await enrollRunner("backend-runner-telemetry");
    const token = enrollment.credentials.token;

    await postTelemetry(token, [
      {
        eventType: "agent.session.started",
        payload: {
          timestamp: "2026-04-02T20:05:00.000Z",
          agentType: "codex",
          sessionKey: "session-completed",
          summary: "Started a successful coding task.",
          category: "session",
          status: "running",
        },
      },
      {
        eventType: "agent.summary.updated",
        payload: {
          timestamp: "2026-04-02T20:05:10.000Z",
          agentType: "codex",
          sessionKey: "session-completed",
          summary: "Applied the implementation and verified the results.",
          category: "implementation",
          status: "in-progress",
          tokenUsage: 900,
          filesTouchedCount: 3,
        },
      },
      {
        eventType: "agent.session.completed",
        payload: {
          timestamp: "2026-04-02T20:05:20.000Z",
          agentType: "codex",
          sessionKey: "session-completed",
          summary: "Completed successfully.",
          category: "session",
          status: "completed",
          durationMs: 20_000,
          tokenUsage: 1_200,
          filesTouchedCount: 4,
        },
      },
      {
        eventType: "agent.session.started",
        payload: {
          timestamp: "2026-04-02T20:06:00.000Z",
          agentType: "codex",
          sessionKey: "session-failed",
          summary: "Started a failing coding task.",
          category: "session",
          status: "running",
        },
      },
      {
        eventType: "agent.prompt.executed",
        payload: {
          timestamp: "2026-04-02T20:06:12.000Z",
          agentType: "codex",
          sessionKey: "session-failed",
          summary: "Build errors blocked the task.",
          category: "build",
          status: "blocked",
          tokenUsage: 700,
          filesTouchedCount: 2,
        },
      },
      {
        eventType: "agent.session.failed",
        payload: {
          timestamp: "2026-04-02T20:06:25.000Z",
          agentType: "codex",
          sessionKey: "session-failed",
          summary: "Session failed after repeated build errors.",
          category: "failure",
          status: "failed",
          durationMs: 25_000,
          tokenUsage: 1_050,
          filesTouchedCount: 3,
        },
      },
    ]);

    const completedSessionsResponse = await app.inject({
      method: "GET",
      url: "/v1/sessions?status=completed&agentType=codex&search=successful",
    });
    assert.equal(completedSessionsResponse.statusCode, 200);

    const completedSessions = completedSessionsResponse.json() as Array<{
      sessionKey: string;
      status: string;
    }>;
    assert.equal(completedSessions.length, 1);
    assert.equal(completedSessions[0]?.sessionKey, "session-completed");
    assert.equal(completedSessions[0]?.status, "completed");

    const failedSessionsResponse = await app.inject({
      method: "GET",
      url: `/v1/sessions?status=failed&agentType=codex&runnerId=${enrollment.runner.id}`,
    });
    assert.equal(failedSessionsResponse.statusCode, 200);

    const failedSessions = failedSessionsResponse.json() as Array<{
      sessionKey: string;
      status: string;
      eventCount: number;
    }>;
    assert.equal(failedSessions.length, 1);
    assert.equal(failedSessions[0]?.sessionKey, "session-failed");
    assert.equal(failedSessions[0]?.status, "failed");
    assert.equal(failedSessions[0]?.eventCount, 3);

    const failedEventsResponse = await app.inject({
      method: "GET",
      url: "/v1/events?eventType=agent.session.failed&agentType=codex&search=build",
    });
    assert.equal(failedEventsResponse.statusCode, 200);

    const failedEvents = failedEventsResponse.json() as Array<{
      eventType: string;
      payload: {
        category?: string;
        status?: string;
      };
    }>;
    assert.equal(failedEvents.length, 1);
    assert.equal(failedEvents[0]?.eventType, "agent.session.failed");
    assert.equal(failedEvents[0]?.payload.category, "failure");
    assert.equal(failedEvents[0]?.payload.status, "failed");
  });
}
