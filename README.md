# FlexBudget

A soft, flexible budget for variable income — made for a hairstylist whose pay changes month to month.

- **Income** — log each deposit (services, tips, product sales) as it comes in, with an optional monthly goal.
- **Fixed bills** — add them once; they repeat every month. Check them off as they're paid.
- **Categories** — divvy up what's left after bills. Each category gets money by **% of flexible money**, a **set amount**, or **leftovers**.
- **Spending** — log purchases into a category and see what's left in each.

## No account needed

Everything is saved in the browser's `localStorage` on the device, so it's still there after the tab is closed. Use **Settings → Download backup** to move data to another device.

On iPhone, open the site in Safari → Share → **Add to Home Screen**. It runs like an app and iOS won't clear its data after a week of not visiting.

## Tech

Plain HTML, CSS and JavaScript — no build step. Deployed on Netlify (`netlify.toml`).
