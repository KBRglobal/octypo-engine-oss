# Insights listing quick E2E scenarios

```yaml
id: J-INSIGHTS-01
title: The latest article is clearly featured
state: clean-state
platforms: [web]
given: local mock engine has 25 published articles and the browser is on /insights
actions:
  - load the listing at desktop and mobile widths
expect_screen: one featured article appears first with a loaded image, category, complete title, summary and article link
expect_system: the listing endpoint is requested with limit=12 and offset=0
evidence: screenshots/J-INSIGHTS-01.web-desktop.png, screenshots/J-INSIGHTS-01.web-mobile.png, logs/web.log
status: Not run
owner_run: —
```

```yaml
id: J-INSIGHTS-02
title: Many articles form a compact responsive grid
state: stateful-journey
platforms: [web]
given: local mock engine has 25 published articles and the browser is on /insights
actions:
  - inspect the listing at desktop, tablet and mobile widths
expect_screen: the first page has one featured article and eleven compact cards; the grid is three columns on desktop, two on tablet and one on mobile without horizontal overflow
expect_system: no data changes
evidence: screenshots/J-INSIGHTS-02.web-desktop.png, screenshots/J-INSIGHTS-02.web-tablet.png, screenshots/J-INSIGHTS-02.web-mobile.png
status: Not run
owner_run: —
```

```yaml
id: J-INSIGHTS-03
title: Pagination exposes crawlable archive pages
state: stateful-journey
platforms: [web]
given: local mock engine has 25 published articles
actions:
  - open /insights/page/2
  - follow Previous and Next links
  - request /insights/page/99
expect_screen: page 2 shows twelve compact cards with previous and next links; an invalid page returns 404
expect_system: page 2 requests limit=12 and offset=12
evidence: screenshots/J-INSIGHTS-03.web.png, traces/J-INSIGHTS-03.zip
status: Not run
owner_run: —
```

```yaml
id: J-INSIGHTS-04
title: Images and text remain usable at all required widths
state: stateful-journey
platforms: [web]
given: local mock engine is running and the browser is on /insights
actions:
  - test 320, 360, 390, 430, 768, 820, 1024, 1280, 1366, 1440 and 1920 pixel widths
expect_screen: images load without distortion, titles are complete, spacing remains intentional and no horizontal overflow appears
expect_system: no data changes
evidence: screenshots/J-INSIGHTS-04.*.png
status: Not run
owner_run: —
```

```yaml
id: J-INSIGHTS-05
title: Empty and missing archive states are explicit
state: clean-state
platforms: [web]
given: local mock engine can return an empty first page or an out-of-range page
actions:
  - render an empty first page
  - request an archive page beyond the total
expect_screen: the empty first page explains that nothing is published; the out-of-range archive returns 404 rather than a blank page
expect_system: no data changes
evidence: screenshots/J-INSIGHTS-05.web.png
status: Not run
owner_run: —
```
