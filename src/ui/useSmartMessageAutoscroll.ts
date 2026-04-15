import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  getNewMessageIds,
  getStoredMessageScrollTop,
  isNearBottom,
  setStoredMessageScrollTop,
  type MessageScrollStreamType,
} from "./messageScrollState";

interface UseSmartMessageAutoscrollParams {
  streamType: MessageScrollStreamType;
  streamId: string | null;
  messageIds: string[];
  nearBottomThresholdPx?: number;
  overlayRef?: RefObject<HTMLElement | null>;
  bottomObscurerSelector?: string;
  bottomOverlayGapPx?: number;
}

interface StreamContext {
  type: MessageScrollStreamType;
  id: string;
}

export function useSmartMessageAutoscroll({
  streamType,
  streamId,
  messageIds,
  nearBottomThresholdPx = 80,
  overlayRef,
  bottomObscurerSelector,
  bottomOverlayGapPx = 12,
}: UseSmartMessageAutoscrollParams) {
  const messagesContainerRef = useRef<HTMLElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const [unreadCount, setUnreadCount] = useState(0);

  const activeStreamRef = useRef<StreamContext | null>(null);
  const initializedForStreamRef = useRef(false);
  const previousMessageIdsRef = useRef<string[]>([]);
  const persistTimerRef = useRef<number | null>(null);
  const nearBottomRef = useRef(true);
  const appliedBottomOverlayOffsetRef = useRef(0);

  const pendingInitialModeRef = useRef<"none" | "restore" | "bottom">("none");
  const pendingRestoreTopRef = useRef<number | null>(null);

  const getBottomOverlap = useCallback(
    (containerRect: DOMRect, target: Element | null | undefined) => {
      if (!target) return 0;
      const rect = target.getBoundingClientRect();
      if (rect.height <= 0 || rect.width <= 0) return 0;
      const overlap = containerRect.bottom - rect.top;
      if (overlap <= 0) return 0;
      return Math.min(overlap, containerRect.height);
    },
    [],
  );

  const streamContext = useMemo<StreamContext | null>(() => {
    const normalizedId = streamId?.trim() ?? "";
    if (!normalizedId) return null;
    return {
      type: streamType,
      id: normalizedId,
    };
  }, [streamType, streamId]);

  useEffect(() => {
    const recalculateBottomOffset = () => {
      const container = messagesContainerRef.current;
      if (!container) return;
      const containerRect = container.getBoundingClientRect();
      const overlayOverlap = getBottomOverlap(containerRect, overlayRef?.current);
      const obscurerOverlap = bottomObscurerSelector
        ? getBottomOverlap(
            containerRect,
            document.querySelector(bottomObscurerSelector),
          )
        : 0;
      const rawOffset = Math.max(overlayOverlap, obscurerOverlap);
      const effectiveOffset =
        rawOffset > 0 ? Math.ceil(rawOffset + bottomOverlayGapPx) : 0;
      const previousOffset = appliedBottomOverlayOffsetRef.current;
      container.style.setProperty(
        "--messages-bottom-overlay-offset",
        `${effectiveOffset}px`,
      );
      appliedBottomOverlayOffsetRef.current = effectiveOffset;
      if (nearBottomRef.current && effectiveOffset > previousOffset) {
        container.scrollTop = container.scrollHeight;
      }
    };

    recalculateBottomOffset();

    const resizeObserver =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(recalculateBottomOffset)
        : null;
    if (resizeObserver) {
      const container = messagesContainerRef.current;
      if (container) resizeObserver.observe(container);
      const overlay = overlayRef?.current;
      if (overlay) resizeObserver.observe(overlay);
      if (bottomObscurerSelector) {
        const obscurer = document.querySelector(bottomObscurerSelector);
        if (obscurer) resizeObserver.observe(obscurer);
      }
    }

    window.addEventListener("resize", recalculateBottomOffset);
    window.addEventListener("orientationchange", recalculateBottomOffset);
    const viewport = window.visualViewport;
    viewport?.addEventListener("resize", recalculateBottomOffset);
    viewport?.addEventListener("scroll", recalculateBottomOffset);

    return () => {
      resizeObserver?.disconnect();
      window.removeEventListener("resize", recalculateBottomOffset);
      window.removeEventListener("orientationchange", recalculateBottomOffset);
      viewport?.removeEventListener("resize", recalculateBottomOffset);
      viewport?.removeEventListener("scroll", recalculateBottomOffset);
    };
  }, [
    bottomObscurerSelector,
    bottomOverlayGapPx,
    getBottomOverlap,
    overlayRef,
  ]);

  const clearPersistTimer = useCallback(() => {
    if (persistTimerRef.current === null) return;
    window.clearTimeout(persistTimerRef.current);
    persistTimerRef.current = null;
  }, []);

  const persistPositionForStream = useCallback((stream: StreamContext | null) => {
    if (!stream) return;
    const container = messagesContainerRef.current;
    if (!container) return;
    setStoredMessageScrollTop({
      streamType: stream.type,
      streamId: stream.id,
      scrollTop: container.scrollTop,
    });
  }, []);

  const schedulePersist = useCallback(() => {
    clearPersistTimer();
    persistTimerRef.current = window.setTimeout(() => {
      persistPositionForStream(activeStreamRef.current);
      persistTimerRef.current = null;
    }, 180);
  }, [clearPersistTimer, persistPositionForStream]);

  const applyInitialViewportPosition = useCallback(() => {
    const mode = pendingInitialModeRef.current;
    if (mode === "none") return;
    const container = messagesContainerRef.current;
    if (!container) return;

    if (mode === "restore") {
      const savedTop = pendingRestoreTopRef.current ?? 0;
      const normalizedTop = Math.max(0, Math.min(savedTop, container.scrollHeight));
      container.scrollTop = normalizedTop;
    } else {
      container.scrollTop = container.scrollHeight;
    }

    nearBottomRef.current = isNearBottom({
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
      clientHeight: container.clientHeight,
      thresholdPx: nearBottomThresholdPx,
    });

    pendingInitialModeRef.current = "none";
    pendingRestoreTopRef.current = null;
    schedulePersist();
  }, [nearBottomThresholdPx, schedulePersist]);

  const onMessagesScroll = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return;

    const nearBottom = isNearBottom({
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
      clientHeight: container.clientHeight,
      thresholdPx: nearBottomThresholdPx,
    });

    nearBottomRef.current = nearBottom;
    if (nearBottom) {
      setUnreadCount((previous) => (previous === 0 ? previous : 0));
    }

    schedulePersist();
  }, [nearBottomThresholdPx, schedulePersist]);

  const jumpToLatest = useCallback(() => {
    const container = messagesContainerRef.current;
    if (!container) return;
    container.scrollTo({
      top: container.scrollHeight,
      behavior: "smooth",
    });
    nearBottomRef.current = true;
    setUnreadCount(0);
    schedulePersist();
  }, [schedulePersist]);

  useEffect(() => {
    const previousStream = activeStreamRef.current;
    if (previousStream) {
      persistPositionForStream(previousStream);
    }

    activeStreamRef.current = streamContext;
    previousMessageIdsRef.current = [];
    initializedForStreamRef.current = false;
    nearBottomRef.current = true;
    setUnreadCount(0);

    if (!streamContext) {
      pendingInitialModeRef.current = "none";
      pendingRestoreTopRef.current = null;
      return;
    }

    const savedTop = getStoredMessageScrollTop(streamContext.type, streamContext.id);
    if (savedTop !== null) {
      pendingInitialModeRef.current = "restore";
      pendingRestoreTopRef.current = savedTop;
    } else {
      pendingInitialModeRef.current = "bottom";
      pendingRestoreTopRef.current = null;
    }
  }, [streamContext, persistPositionForStream]);

  useEffect(() => {
    if (!streamContext) return;
    const mode = pendingInitialModeRef.current;
    if (mode === "restore" && messageIds.length === 0) {
      return;
    }
    const frameId = window.requestAnimationFrame(() => {
      applyInitialViewportPosition();
    });
    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [applyInitialViewportPosition, messageIds.length, streamContext]);

  useEffect(() => {
    if (!streamContext) return;

    if (!initializedForStreamRef.current) {
      initializedForStreamRef.current = true;
      previousMessageIdsRef.current = messageIds;
      return;
    }

    const newIds = getNewMessageIds(previousMessageIdsRef.current, messageIds);
    previousMessageIdsRef.current = messageIds;
    if (newIds.length === 0) return;

    const container = messagesContainerRef.current;
    if (!container) return;

    const nearBottom = isNearBottom({
      scrollTop: container.scrollTop,
      scrollHeight: container.scrollHeight,
      clientHeight: container.clientHeight,
      thresholdPx: nearBottomThresholdPx,
    });
    nearBottomRef.current = nearBottom;

    if (nearBottom) {
      container.scrollTo({
        top: container.scrollHeight,
        behavior: "smooth",
      });
      setUnreadCount(0);
      schedulePersist();
      return;
    }

    setUnreadCount((previous) => previous + newIds.length);
  }, [messageIds, nearBottomThresholdPx, schedulePersist, streamContext]);

  useEffect(() => {
    return () => {
      clearPersistTimer();
      persistPositionForStream(activeStreamRef.current);
    };
  }, [clearPersistTimer, persistPositionForStream]);

  return {
    messagesContainerRef,
    endRef,
    unreadCount,
    jumpToLatest,
    onMessagesScroll,
  };
}
