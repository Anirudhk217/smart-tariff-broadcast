# Smart-Tariff Broadcast

The cheapest and greenest times to use electricity in your part of Great Britain.

- **On air now:** this half hour's Octopus Agile price and grid carbon intensity for your region, and when the price band changes next.
- **Today's broadcast:** a plain-language summary (plunge pricing, cheapest two hours, the peak to avoid, the greenest two hours) that you can share or copy.
- **Next 48 hours:** price bars and the carbon forecast on one chart, in UK time, clock changes included.
- **Best time to run:** for each appliance (dishwasher, washer, dryer, EV, or your own), the best start time to be cheapest, greenest or both, the cost, and the saving against starting now. **Add to calendar** gives you a reminder.
- Find your region by postcode or pick it from the list. Settings stay on your device. Installs like an app and works offline.

Not on Agile? The **Greenest** setting works for every tariff.

## How it runs

No server and no keys. A GitHub Actions workflow (`.github/workflows/deploy.yml`) runs every hour and on every push to `main`. It:

1. runs the tests,
2. fetches Agile prices for all 14 regions from the public [Octopus Energy API](https://developer.octopus.energy/) and the 48-hour regional forecast from the [Carbon Intensity API](https://carbonintensity.org.uk) into `site/data/latest.json` (`scripts/fetch-data.mjs`),
3. publishes `site/` to GitHub Pages.

The page also tries the two APIs directly for the freshest numbers and falls back to that hourly file if the browser can't reach them. The `latest.json` in the repo is a London-only sample so the app works locally.

### One-time setup

In the repo on GitHub, open **Settings → Pages** and set **Source** to **GitHub Actions**. The app is then at `https://<your-username>.github.io/smart-tariff-broadcast/`.

## Develop

```sh
npm test         # window and time logic, including the October clock change
npm run fetch    # pull live data into site/data/latest.json
npm start        # serve site/ locally
```

Carbon data: National Grid ESO Carbon Intensity API, CC BY 4.0. Not affiliated with Octopus Energy.
