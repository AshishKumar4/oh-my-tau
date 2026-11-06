import { expect, it, vi } from "bun:test";
import { handleGitHub } from "@oh-my-pi/pi-coding-agent/web/scrapers/github";

it("renders deleted issue and comment authors without losing bodies, labels or list entries", async () => {
	const issue = {
		title: "Retained issue",
		number: 12,
		state: "open",
		user: null,
		created_at: "2026-01-01T00:00:00Z",
		updated_at: "2026-01-02T00:00:00Z",
		body: "Issue body",
		labels: [{ name: "bug" }],
		comments: 2,
		html_url: "https://github.com/fixture/repo/issues/12",
	};
	const paths: string[] = [];
	const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			async (input: string | URL | Request) => {
				const url = new URL(input instanceof Request ? input.url : input.toString());
				paths.push(url.pathname);
				if (url.pathname.endsWith("/comments"))
					return Response.json([
						{ user: null, body: "Retained deleted-author comment", created_at: issue.created_at },
						{ user: { login: "current-author" }, body: "Retained current comment", created_at: issue.updated_at },
					]);
				if (url.pathname.endsWith("/issues/12")) return Response.json(issue);
				if (url.pathname.endsWith("/issues"))
					return Response.json([issue, { ...issue, number: 13, user: { login: "current-author" } }]);
				throw new Error(`Unexpected fixture URL ${url.pathname}`);
			},
			{ preconnect() {} },
		),
	);
	try {
		const single = await handleGitHub(issue.html_url, 1000);
		expect(single?.method).toBe("github-issue");
		expect(single?.content).toContain("@ghost");
		expect(single?.content).toContain("Issue body");
		expect(single?.content).toContain("Retained deleted-author comment");
		expect(single?.content).toContain("@current-author");
		const list = await handleGitHub("https://github.com/fixture/repo/issues", 1000);
		expect(list?.method).toBe("github-issues");
		expect(list?.content).toContain("#12");
		expect(list?.content).toContain("#13");
		expect(list?.content).toContain("@ghost");
		expect(list?.content).toContain("@current-author");
		expect(paths).toEqual([
			"/repos/fixture/repo/issues/12",
			"/repos/fixture/repo/issues/12/comments",
			"/repos/fixture/repo/issues",
		]);
	} finally {
		fetch.mockRestore();
	}
});
