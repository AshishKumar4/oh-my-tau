/**
 * Date/cwd reminder injection.
 *
 * The system prompt must stay byte-stable so open-weight chat templates that
 * render tool schemas *after* the system content keep their prefix cache
 * (#7404). The per-request date/cwd line used to live at the tail of the
 * system prompt (`project-prompt.md`), which invalidated the whole tool array
 * on every directory change or day rollover. It now rides on the first user
 * turn of each provider request instead: built at request time (never stored
 * in the session), deterministic per `(date, cwd)`, so the bytes are stable
 * for the lifetime of a session/day and refresh automatically at midnight.
 */
import type { Context, Message, UserMessage } from "@oh-my-pi/pi-ai";
import { contextIdentity, isPerCallContextMessage } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { prompt } from "@oh-my-pi/pi-utils";
import dateCwdReminderTemplate from "../prompts/system/date-cwd-reminder.md" with { type: "text" };

/** Renders the reminder text for the given local calendar date and cwd. */
export function renderDateCwdReminder(date: string, cwd: string): string {
	return prompt.render(dateCwdReminderTemplate, { date, cwd }).trim();
}

function messageStartsWithReminder(message: UserMessage, reminder: string): boolean {
	if (typeof message.content === "string") return message.content.startsWith(reminder);
	return message.content[0]?.type === "text" && message.content[0].text === reminder;
}

function injectReminder(message: UserMessage, reminder: string): UserMessage {
	const content: UserMessage["content"] =
		typeof message.content === "string"
			? `${reminder}\n\n${message.content}`
			: [{ type: "text", text: reminder }, ...message.content];
	return { ...message, content };
}

/** Developer turns the injector inserted; every other output message maps to an input one. */
const reminderControls = new WeakSet<Message>();

/** Whether `message` is a developer turn a {@link DateCwdReminderInjector} inserted. */
export function isDateCwdReminderControl(message: Message): boolean {
	return reminderControls.has(message);
}

/**
 * Keeps volatile date/cwd reminders append-only across provider requests.
 *
 * The first value is attached to the first user turn. A changed value attaches
 * to a newly appended user turn or a persistent developer turn, leaving every
 * previously sent message byte-identical.
 */
export class DateCwdReminderInjector {
	/**
	 * State is kept per {@link contextIdentity}: a context hook's per-call copy of
	 * a history message stands for one message whatever position a call gives it,
	 * so a turn compaction moves keeps the reminder it went out with.
	 *
	 * The reminder each first user turn last went out with. A request rooted at
	 * a turn sent before resumes from its reminder, so a request over another
	 * view of the history (another root) leaves the live root's bytes alone.
	 */
	#rootReminders = new WeakMap<object, string>();
	/** The reminder each user turn carries. */
	#reminders = new WeakMap<object, string>();
	/** Each user turn as last sent with its reminder, rebuilt when its content or reminder changes. */
	#injected = new WeakMap<UserMessage, { content: UserMessage["content"]; reminder: string; message: UserMessage }>();
	/** Reminder controls, by the message they follow. */
	#controls = new WeakMap<object, Message[]>();
	#seen = new WeakSet<object>();

	/** Apply the current reminder while preserving all earlier injected bytes. */
	transform(context: Context, date: string, cwd: string): Context {
		if (!context.systemPrompt || context.systemPrompt.length === 0 || context.messages.length === 0) return context;
		const reminder = renderDateCwdReminder(date, cwd);
		const messages = this.#inject(context.messages, reminder);
		return messages === context.messages ? context : { ...context, messages };
	}

	#inject(messages: Message[], reminder: string): Message[] {
		const firstUser = messages.find((message): message is UserMessage => message.role === "user");
		if (!firstUser) return messages;
		const root = contextIdentity(firstUser);
		const sent = this.#rootReminders.get(root);
		if (sent === undefined) {
			// A new compaction root must not rewrite reminders on retained turns.
			if (!this.#reminders.has(root) && !messageStartsWithReminder(firstUser, reminder)) {
				this.#reminders.set(root, reminder);
			}
		} else if (sent !== reminder) {
			// A context hook rebuilds its per-call messages on every request, so a
			// reminder riding on one, or following one, would be gone from the next.
			const history = messages.filter(message => !isPerCallContextMessage(message));
			const newUser = history.findLast(
				(candidate): candidate is UserMessage =>
					candidate.role === "user" && !this.#seen.has(contextIdentity(candidate)),
			);
			if (newUser) {
				this.#reminders.set(contextIdentity(newUser), reminder);
			} else {
				const anchor = contextIdentity(history.at(-1) ?? firstUser);
				const control: Message = {
					role: "developer",
					content: reminder,
					synthetic: true,
					timestamp: Date.now(),
				};
				reminderControls.add(control);
				const controls = this.#controls.get(anchor);
				if (controls) controls.push(control);
				else this.#controls.set(anchor, [control]);
			}
		}
		this.#rootReminders.set(root, reminder);

		let changed = false;
		const out: Message[] = [];
		for (const message of messages) {
			const identity = contextIdentity(message);
			const carried = message.role === "user" && this.#reminders.get(identity);
			out.push(carried ? this.#withReminder(message, carried) : message);
			if (carried) changed = true;
			const controls = this.#controls.get(identity);
			if (controls) {
				out.push(...controls);
				changed = true;
			}
			this.#seen.add(identity);
		}
		return changed ? out : messages;
	}

	#withReminder(message: UserMessage, reminder: string): UserMessage {
		const cached = this.#injected.get(message);
		if (cached?.content === message.content && cached.reminder === reminder) return cached.message;
		const injected = injectReminder(message, reminder);
		this.#injected.set(message, { content: message.content, reminder, message: injected });
		return injected;
	}
}
