// MUST stay first: ESM evaluates static dependencies before the importer's body, so this is the
// only position from which the stderr cap covers the other modules' own initialization.
import "./bounded-stderr-install.js";
import net from "net";
import { writeFileSync, unlinkSync, mkdirSync } from "fs";
import { randomUUID } from "crypto";
import { writeMessage, createMessageReader } from "./framing.js";
import { getBrokerPidPath, getBrokerSocketPath, getIntercomDirPath } from "./paths.js";
import type { SessionInfo, BrokerMessage, SupervisorRegistration } from "../types.js";
import { DeliveredMessageCache } from "./delivered-message-cache.js";
import {
  handleBrokerSend,
  pendingStageAskRefusal,
  parsePendingStageTarget,
  type BrokerConnectedSession,
  type PendingStageRoute,
} from "./send-handler.js";
import { SupervisorChannelCache } from "./supervisor-channel.js";
import { normalizeGroup } from "../group.js";
import { handleBrokerPresence } from "./presence-handler.js";
import { PendingQuestionIndex } from "./pending-question-index.js";

const INTERCOM_DIR = getIntercomDirPath();
const SOCKET_PATH = getBrokerSocketPath();
const PID_PATH = getBrokerPidPath();

const PENDING_STAGE_MESSAGE_TIMEOUT_MS = 10_000;

interface PendingStageRouteRegistration {
  readonly sessionId: string;
  readonly group: string;
  readonly capability: string;
}

interface PendingStageAcknowledgment {
  readonly ownerSessionId: string;
  readonly senderSocket: net.Socket;
  readonly messageId: string;
  readonly attemptId?: string;
  readonly runId: string;
  readonly stageKey: string;
  readonly timeout: NodeJS.Timeout;
}

interface LiveWorkflowStageRouteRegistration {
  readonly sessionId: string;
  readonly capability: string;
}

interface LiveWorkflowStageRouteActivation {
  readonly sessionId: string;
  readonly pendingRequestIds: Set<string>;
}

type ConnectedSession = BrokerConnectedSession;

function isSessionRegistration(value: unknown): value is Omit<SessionInfo, "id"> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const session = value as Record<string, unknown>;

  if (
    typeof session.cwd !== "string"
    || typeof session.model !== "string"
    || typeof session.pid !== "number"
    || typeof session.startedAt !== "number"
    || typeof session.lastActivity !== "number"
  ) {
    return false;
  }

  if (session.name !== undefined && typeof session.name !== "string") {
    return false;
  }

  if (session.group !== undefined && typeof session.group !== "string") {
    return false;
  }

  return session.status === undefined || typeof session.status === "string";
}
function isSupervisorRegistration(value: unknown): value is SupervisorRegistration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const registration = value as Record<string, unknown>;
  return typeof registration.capability === "string"
    && typeof registration.supervisorSessionId === "string";
}


class IntercomBroker {
  private sessions = new Map<string, ConnectedSession>();
  private server: net.Server;
  private shutdownTimer: NodeJS.Timeout | null = null;
  private deliveredMessages = new DeliveredMessageCache();
  private supervisorChannel = new SupervisorChannelCache();
  private pendingQuestions = new PendingQuestionIndex();
  private pendingStageRoutes = new Map<string, PendingStageRouteRegistration>();
  private pendingStageAcknowledgments = new Map<string, PendingStageAcknowledgment>();
  private liveWorkflowStageRoutes = new Map<string, LiveWorkflowStageRouteRegistration>();
  private liveWorkflowStageRouteActivations = new Map<string, LiveWorkflowStageRouteActivation>();

  constructor() {
    mkdirSync(INTERCOM_DIR, { recursive: true });
    if (process.platform !== "win32") {
      try {
        unlinkSync(SOCKET_PATH);
      } catch {
        // A clean startup has no stale socket to remove.
      }
    }
    this.server = net.createServer(this.handleConnection.bind(this));
  }

  start(): void {
    this.server.listen(SOCKET_PATH, () => {
      writeFileSync(PID_PATH, String(process.pid));
      console.log(`Intercom broker started (pid: ${process.pid})`);
    });
    process.on("SIGTERM", () => this.shutdown());
    process.on("SIGINT", () => this.shutdown());
  }

  private handleConnection(socket: net.Socket): void {
    let sessionId: string | null = null;

    const reader = createMessageReader((msg) => {
      this.handleMessage(socket, msg, sessionId, (id) => {
        sessionId = id;
      });
    }, (error) => {
      socket.destroy(error);
    });

    socket.on("data", reader);

    socket.on("close", () => {
      if (sessionId) {
        this.disconnectSession(sessionId);
        this.scheduleShutdownCheck();
      }
    });

    socket.on("error", (error) => {
      console.error("Socket error:", error);
    });
  }

  private scheduleShutdownCheck(): void {
    if (this.shutdownTimer) return;

    this.shutdownTimer = setTimeout(() => {
      this.shutdownTimer = null;
      if (this.sessions.size === 0) {
        console.log("No sessions connected, shutting down");
        this.shutdown();
      }
    }, 5000);
  }
  private resolveLiveWorkflowStage = (target: string): ConnectedSession | undefined => {
    const registration = this.liveWorkflowStageRoutes.get(target);
    if (registration === undefined) return undefined;
    const parsedTarget = parsePendingStageTarget(target);
    const currentOwner = parsedTarget === undefined ? undefined : this.pendingStageRoutes.get(parsedTarget.runId);
    if (currentOwner !== undefined && currentOwner.capability !== registration.capability) {
      this.liveWorkflowStageRoutes.delete(target);
      return undefined;
    }
    const session = this.sessions.get(registration.sessionId);
    if (session !== undefined) return session;
    this.liveWorkflowStageRoutes.delete(target);
    return undefined;
  };

  private acknowledgeLiveWorkflowStageRoute(requestId: string): void {
    const activation = this.liveWorkflowStageRouteActivations.get(requestId);
    if (activation === undefined || activation.pendingRequestIds.size > 0) return;
    this.liveWorkflowStageRouteActivations.delete(requestId);
    const stage = this.sessions.get(activation.sessionId);
    if (stage !== undefined) writeMessage(stage.socket, { type: "live_workflow_stage_route_registered", requestId });
  }

  private releasePendingStageAcknowledgment(requestId: string): void {
    for (const [activationId, activation] of this.liveWorkflowStageRouteActivations) {
      if (!activation.pendingRequestIds.delete(requestId)) continue;
      this.acknowledgeLiveWorkflowStageRoute(activationId);
    }
  }

  private registerLiveWorkflowStageRoute(
    currentId: string,
    requestId: string,
    runId: string,
    stageKeys: readonly string[],
    capability: string,
  ): boolean {
    const uniqueStageKeys = [...new Set(stageKeys)];
    const targets = uniqueStageKeys.map((stageKey) => `${runId}:${stageKey}`);
    for (const target of targets) {
      const existing = this.liveWorkflowStageRoutes.get(target);
      if (
        existing !== undefined &&
        existing.sessionId !== currentId &&
        this.sessions.has(existing.sessionId)
      ) {
        return false;
      }
    }
    for (const target of targets) {
      this.liveWorkflowStageRoutes.set(target, { sessionId: currentId, capability });
    }
    const pendingRequestIds = new Set(
      [...this.pendingStageAcknowledgments]
        .filter(([, pending]) => pending.runId === runId && uniqueStageKeys.includes(pending.stageKey))
        .map(([pendingRequestId]) => pendingRequestId),
    );
    this.liveWorkflowStageRouteActivations.set(requestId, { sessionId: currentId, pendingRequestIds });
    this.acknowledgeLiveWorkflowStageRoute(requestId);
    return true;
  }

  private routePendingStage = (route: PendingStageRoute): boolean => {
    const ownerRegistration = this.pendingStageRoutes.get(route.runId);
    if (ownerRegistration === undefined) return false;
    const owner = this.sessions.get(ownerRegistration.sessionId);
    if (owner === undefined) {
      this.pendingStageRoutes.delete(route.runId);
      return false;
    }
    if (normalizeGroup(route.from.info.group) !== normalizeGroup(ownerRegistration.group)) {
      writeMessage(route.socket, {
        type: "delivery_failed",
        messageId: route.message.id,
        ...(route.attemptId ? { attemptId: route.attemptId } : {}),
        reason: "Target workflow run is in a different intercom group",
      });
      return true;
    }
    const askRefusal = pendingStageAskRefusal(route.message);
    if (askRefusal !== undefined) {
      writeMessage(route.socket, {
        type: "delivery_failed",
        messageId: route.message.id,
        ...(route.attemptId ? { attemptId: route.attemptId } : {}),
        reason: askRefusal,
      });
      return true;
    }
    const requestId = randomUUID();
    const timeout = setTimeout(() => {
      const pending = this.pendingStageAcknowledgments.get(requestId);
      if (pending === undefined) return;
      this.pendingStageAcknowledgments.delete(requestId);
      this.releasePendingStageAcknowledgment(requestId);
      writeMessage(pending.senderSocket, {
        type: "delivery_failed",
        messageId: pending.messageId,
        ...(pending.attemptId ? { attemptId: pending.attemptId } : {}),
        reason: "Pending-stage route did not acknowledge the message",
      });
    }, PENDING_STAGE_MESSAGE_TIMEOUT_MS);
    this.pendingStageAcknowledgments.set(requestId, {
      ownerSessionId: ownerRegistration.sessionId,
      senderSocket: route.socket,
      messageId: route.message.id,
      ...(route.attemptId ? { attemptId: route.attemptId } : {}),
      runId: route.runId,
      stageKey: route.stageKey,
      timeout,
    });
    writeMessage(owner.socket, {
      type: "pending_stage_message",
      requestId,
      from: route.from.info,
      runId: route.runId,
      stageKey: route.stageKey,
      message: route.message,
    });
    return true;
  };

  private settlePendingStageMessageRequest(
    currentId: string,
    requestId: string,
    outcome: "queued" | "refused",
    position: number | undefined,
    reason: string | undefined,
  ): void {
    const pending = this.pendingStageAcknowledgments.get(requestId);
    if (pending === undefined || pending.ownerSessionId !== currentId) return;
    clearTimeout(pending.timeout);
    this.pendingStageAcknowledgments.delete(requestId);
    this.releasePendingStageAcknowledgment(requestId);
    if (outcome === "queued" && typeof position === "number" && position > 0) {
      writeMessage(pending.senderSocket, {
        type: "queued",
        messageId: pending.messageId,
        ...(pending.attemptId ? { attemptId: pending.attemptId } : {}),
        runId: pending.runId,
        stageKey: pending.stageKey,
        position,
      });
      return;
    }
    writeMessage(pending.senderSocket, {
      type: "delivery_failed",
      messageId: pending.messageId,
      ...(pending.attemptId ? { attemptId: pending.attemptId } : {}),
      reason: reason ?? "Pending-stage delivery was refused",
    });
  }


  private handleMessage(
    socket: net.Socket,
    msg: unknown,
    currentId: string | null,
    setId: (id: string | null) => void,
  ): void {
    if (typeof msg !== "object" || msg === null || !("type" in msg) || typeof msg.type !== "string") {
      throw new Error("Invalid client message");
    }

    const clientMessage = msg as { type: string } & Record<string, unknown>;

    if (currentId === null && clientMessage.type !== "register") {
      throw new Error(`Received ${clientMessage.type} before register`);
    }

    switch (clientMessage.type) {
      case "register": {
        if (!isSessionRegistration(clientMessage.session)) {
          throw new Error("Invalid register message");
        }
        if (clientMessage.supervisorOwnerToken !== undefined
          && (typeof clientMessage.supervisorOwnerToken !== "string" || !clientMessage.supervisorOwnerToken)) {
          throw new Error("Invalid supervisor owner token");
        }

        if (currentId) {
          throw new Error("Received duplicate register message");
        }

        let supervisorId: string | undefined;
        if (clientMessage.supervisor !== undefined) {
          const childName = clientMessage.session.name?.trim();
          const claimedSupervisorId = isSupervisorRegistration(clientMessage.supervisor) && childName
            ? this.supervisorChannel.claim(clientMessage.supervisor.capability, childName)
            : undefined;
          if (!claimedSupervisorId || !this.sessions.has(claimedSupervisorId)) {
            writeMessage(socket, { type: "registration_failed", reason: "Invalid supervisor authorization" });
            socket.end();
            return;
          }
          supervisorId = claimedSupervisorId;
        }

        const id = randomUUID();
        setId(id);
        const info: SessionInfo = {
          ...clientMessage.session,
          id,
          group: normalizeGroup(clientMessage.session.group),
        };
        this.sessions.set(id, {
          socket,
          info,
          ...(supervisorId ? { supervisorId } : {}),
          ...(typeof clientMessage.supervisorOwnerToken === "string"
            ? { supervisorOwnerToken: clientMessage.supervisorOwnerToken }
            : {}),
        });

        if (this.shutdownTimer) {
          clearTimeout(this.shutdownTimer);
          this.shutdownTimer = null;
        }

        writeMessage(socket, supervisorId
          ? { type: "registered", sessionId: id, supervisorSessionId: supervisorId }
          : { type: "registered", sessionId: id });
        this.broadcastToGroup({ type: "session_joined", session: info }, info.group, id);
        break;
      }

      case "unregister": {
        this.disconnectSession(currentId);
        setId(null);
        this.scheduleShutdownCheck();
        break;
      }

      case "list": {
        if (typeof clientMessage.requestId !== "string") {
          throw new Error("Invalid list message");
        }
        if (clientMessage.group !== undefined && typeof clientMessage.group !== "string") {
          throw new Error("Invalid list group");
        }

        const requester = currentId ? this.sessions.get(currentId) : undefined;
        const effectiveGroup = normalizeGroup(
          typeof clientMessage.group === "string" ? clientMessage.group : requester?.info.group,
        );
        const sessions = Array.from(this.sessions.values())
          .map((s) => s.info)
          .filter((info) => normalizeGroup(info.group) === effectiveGroup);
        writeMessage(socket, { type: "sessions", requestId: clientMessage.requestId, sessions });
        break;
      }

      case "authorize_supervisor": {
        const supervisor = this.sessions.get(currentId);
        if (!supervisor?.supervisorOwnerToken || typeof clientMessage.requestId !== "string"
          || typeof clientMessage.childName !== "string" || !clientMessage.childName.trim()
          || (clientMessage.capability !== undefined && typeof clientMessage.capability !== "string")) {
          throw new Error("Invalid authorize_supervisor message");
        }
        const childName = clientMessage.childName.trim();
        const capability = this.supervisorChannel.authorize(
          supervisor.info.id,
          supervisor.supervisorOwnerToken,
          childName,
          typeof clientMessage.capability === "string" ? clientMessage.capability : undefined,
        );
        writeMessage(socket, {
          type: "supervisor_authorized",
          requestId: clientMessage.requestId,
          capability,
          supervisorSessionId: supervisor.info.id,
          childName,
        });
        break;
      }

      case "register_pending_stage_route": {
        if (
          typeof clientMessage.runId !== "string" ||
          !clientMessage.runId ||
          typeof clientMessage.group !== "string" ||
          typeof clientMessage.capability !== "string" ||
          !clientMessage.capability
        ) {
          throw new Error("Invalid pending-stage route registration");
        }
        const owner = this.sessions.get(currentId);
        const existing = this.pendingStageRoutes.get(clientMessage.runId);
        if (
          owner === undefined ||
          normalizeGroup(clientMessage.group) !== normalizeGroup(owner.info.group) ||
          (existing !== undefined &&
            (existing.sessionId !== currentId || existing.capability !== clientMessage.capability) &&
            this.sessions.has(existing.sessionId))
        ) {
          writeMessage(socket, { type: "registration_failed", reason: "Pending-stage route is not authorized" });
          socket.end();
          return;
        }
        this.pendingStageRoutes.set(clientMessage.runId, {
          sessionId: currentId,
          group: normalizeGroup(owner.info.group),
          capability: clientMessage.capability,
        });
        break;
      }

      case "register_live_workflow_stage_route": {
        if (
          typeof clientMessage.requestId !== "string" ||
          typeof clientMessage.runId !== "string" ||
          typeof clientMessage.capability !== "string" ||
          !clientMessage.capability ||
          !Array.isArray(clientMessage.stageKeys) ||
          clientMessage.stageKeys.length < 1 ||
          clientMessage.stageKeys.length > 2 ||
          !clientMessage.stageKeys.every(
            (stageKey) =>
              typeof stageKey === "string" &&
              stageKey.length > 0 &&
              parsePendingStageTarget(`${clientMessage.runId}:${stageKey}`) !== undefined,
          )
        ) {
          throw new Error("Invalid live workflow-stage route registration");
        }
        const ownerRegistration = this.pendingStageRoutes.get(clientMessage.runId);
        const registeringSession = this.sessions.get(currentId);
        if (
          ownerRegistration === undefined ||
          registeringSession === undefined ||
          ownerRegistration.capability !== clientMessage.capability ||
          normalizeGroup(ownerRegistration.group) !== normalizeGroup(registeringSession.info.group) ||
          !this.registerLiveWorkflowStageRoute(
            currentId,
            clientMessage.requestId,
            clientMessage.runId,
            clientMessage.stageKeys,
            clientMessage.capability,
          )
        ) {
          writeMessage(socket, {
            type: "registration_failed",
            reason: "Live workflow-stage route is owned by another active session",
          });
          socket.end();
          return;
        }
        break;
      }

      case "pending_stage_message_result": {
        if (
          typeof clientMessage.requestId !== "string" ||
          (clientMessage.outcome !== "queued" && clientMessage.outcome !== "refused") ||
          (clientMessage.position !== undefined && typeof clientMessage.position !== "number") ||
          (clientMessage.reason !== undefined && typeof clientMessage.reason !== "string")
        ) {
          throw new Error("Invalid pending-stage message result");
        }
        this.settlePendingStageMessageRequest(
          currentId,
          clientMessage.requestId,
          clientMessage.outcome,
          clientMessage.position,
          clientMessage.reason,
        );
        break;
      }

      case "send":
      case "supervisor_send": {
        handleBrokerSend(
          socket,
          clientMessage,
          currentId,
          this.sessions,
          this.deliveredMessages,
          writeMessage,
          this.supervisorChannel,
          this.pendingQuestions,
          this.routePendingStage,
          this.resolveLiveWorkflowStage,
        );
        break;
      }

      case "presence": {
        handleBrokerPresence(
          socket,
          clientMessage,
          currentId,
          this.sessions,
          (target, message) => writeMessage(target, message),
        );
        break;
      }

      default:
        throw new Error(`Unknown client message type: ${clientMessage.type}`);
    }
  }

  private disconnectSession(sessionId: string): void {
    const departed = this.sessions.get(sessionId);
    if (!departed) return;

    this.pendingQuestions.pruneSender(sessionId);
    for (const question of this.pendingQuestions.takeForTarget(sessionId)) {
      const asker = this.sessions.get(question.senderSessionId);
      if (!asker) continue;
      writeMessage(asker.socket, {
        type: "peer_disconnected",
        replyTo: question.messageId,
        peerSessionId: departed.info.id,
        ...(departed.info.name !== undefined ? { peerName: departed.info.name } : {}),
      });
    }

    for (const [runId, owner] of this.pendingStageRoutes) {
      if (owner.sessionId === sessionId) this.pendingStageRoutes.delete(runId);
    }
    for (const [requestId, pending] of this.pendingStageAcknowledgments) {
      if (pending.ownerSessionId !== sessionId) continue;
      clearTimeout(pending.timeout);
      this.pendingStageAcknowledgments.delete(requestId);
      this.releasePendingStageAcknowledgment(requestId);
      writeMessage(pending.senderSocket, {
        type: "delivery_failed",
        messageId: pending.messageId,
        ...(pending.attemptId ? { attemptId: pending.attemptId } : {}),
        reason: "Pending-stage route disconnected before acknowledging the message",
      });
    }
    for (const [target, registration] of this.liveWorkflowStageRoutes) {
      if (registration.sessionId === sessionId) this.liveWorkflowStageRoutes.delete(target);
    }
    for (const [requestId, activation] of this.liveWorkflowStageRouteActivations) {
      if (activation.sessionId === sessionId) this.liveWorkflowStageRouteActivations.delete(requestId);
    }
    this.sessions.delete(sessionId);
    this.broadcastToGroup({ type: "session_left", sessionId }, departed.info.group, sessionId);
  }

  /** Deliver a broadcast only to sessions in the given (normalized) group. */
  private broadcastToGroup(msg: BrokerMessage, group: string | undefined, exclude?: string): void {
    const target = normalizeGroup(group);
    for (const [id, session] of this.sessions) {
      if (id !== exclude && normalizeGroup(session.info.group) === target) {
        writeMessage(session.socket, msg);
      }
    }
  }

  private shutdown(): void {
    console.log("Broker shutting down");

    for (const session of this.sessions.values()) {
      session.socket.end();
    }
    this.sessions.clear();
    this.pendingStageRoutes.clear();
    this.pendingStageAcknowledgments.clear();
    this.liveWorkflowStageRoutes.clear();
    this.liveWorkflowStageRouteActivations.clear();
    if (process.platform !== "win32") {
      try {
        unlinkSync(SOCKET_PATH);
      } catch {
        // The socket may already be gone if shutdown started after a disconnect.
      }
    }
    try {
      unlinkSync(PID_PATH);
    } catch {
      // The PID file may already be gone if startup never completed.
    }
    this.server.close();
    process.exit(0);
  }
}

// The stderr cap is already in place: `./bounded-stderr-install.js` is this file's first import.
new IntercomBroker().start();
