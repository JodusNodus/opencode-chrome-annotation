/** @jsxImportSource @opentui/solid */

import { Plugin } from "@opencode-ai/plugin/tui";
import { createEffect, For, Show } from "solid-js";

type Annotation = {
  id: string;
  comment: string;
  target: string;
};

function field(text: string, label: string, next: string): string {
  return text.match(new RegExp(`${label}:\\n([\\s\\S]*?)\\n\\n${next}:`))?.[1]?.trim() || "";
}

function line(text: string, label: string): string {
  return text.match(new RegExp(`^${label}: (.*)$`, "m"))?.[1]?.trim() || "";
}

function annotations(context: Plugin.Context, sessionID: string): Annotation[] {
  return context.data.session.pending.list(sessionID)
    .filter((item) => item.type === "user" && item.payload.metadata?.source === "chrome-annotation")
    .map((item) => ({
      id: item.id,
      comment: field(item.payload.text, "User comment", "Page") || "(No instruction)",
      target: line(item.payload.text, "Selector") || "Selected page element",
    }));
}

function QueueView(props: { context: Plugin.Context; sessionID: string }) {
  createEffect(() => void props.context.data.session.pending.sync(props.sessionID));
  const items = () => annotations(props.context, props.sessionID);

  return (
    <Show when={items().length > 0}>
      <box width="100%" flexDirection="column" paddingLeft={3} paddingRight={3} paddingBottom={1}>
        <text wrapMode="word">
          Queued browser annotations ({items().length}) — add more in Chrome or run /apply-annotations
        </text>
        <For each={items()}>
          {(item, index) => (
            <box width="100%" flexDirection="column" paddingLeft={2} paddingTop={1}>
              <text wrapMode="word">{index() + 1}. {item.comment}</text>
              <text wrapMode="word">Target: {item.target}</text>
            </box>
          )}
        </For>
      </box>
    </Show>
  );
}

function Controller(props: { context: Plugin.Context }) {
  props.context.keymap.layer(() => {
    const route = props.context.ui.router.current();
    const sessionID = route.type === "session" ? route.sessionID : undefined;
    return {
      mode: "global",
      commands: [{
        id: "chrome-annotation.apply",
        title: "Apply queued browser annotations",
        description: "Start one agent turn using every queued browser annotation",
        group: "Session",
        palette: true,
        slash: { name: "apply-annotations" },
        enabled: Boolean(sessionID && annotations(props.context, sessionID).length),
        run: async () => {
          if (!sessionID) return;
          await props.context.client.session.prompt({
            sessionID,
            text: "Apply all queued browser annotations now as one coherent change.",
            delivery: "steer",
            resume: true,
          });
        },
      }],
    };
  });
  return <></>;
}

export default Plugin.define({
  id: "opencode.chrome-annotation.tui",
  setup(context) {
    const refresh = (sessionID: string) => {
      context.data.session.pending.invalidate(sessionID);
      void context.data.session.pending.sync(sessionID);
    };
    const stops = [
      context.data.on("session.inbox.enqueued", (event) => refresh(event.data.sessionID)),
      context.data.on("session.inbox.delivered", (event) => refresh(event.data.sessionID)),
      context.data.on("session.inbox.cancelled", (event) => refresh(event.data.sessionID)),
    ];
    const stopController = context.ui.slot({
      append: "app",
      render: () => <Controller context={context} />,
    });
    const stopQueue = context.ui.slot({
      append: "session.composer.top",
      render: (props) => <QueueView context={context} sessionID={props.sessionID} />,
    });

    return () => {
      for (const stop of stops) stop();
      stopController();
      stopQueue();
    };
  },
});
