<!-- PROJECT LOGO -->
<p align="center">
  <a href="https://github.com/openathleteorg/openathlete">
   <img src="/doc/imgs/openathlete-showcase.png" alt="OpenAthlete Logo">
  </a>

  <h3 align="center">OpenAthlete</h3>

  <p align="center">
    The ethical European alternative to TrainingPeaks and Strava.
    <br />
    <br />
    OpenAthlete is open source under the AGPLv3, built so you can own your training data: self-host it, audit it, and avoid vendor lock-in. Core hosting and processing are oriented toward the European Union with GDPR-minded defaults.
    <br />
    <a href="https://openathlete.org"><strong>Learn more »</strong></a>
    <br />
    <br />
    <a href="https://discord.gg/j4PP6tDwuP">Discord</a>
    ·
    <a href="https://openathlete.org">Website</a>
    ·
    <a href="https://docs.openathlete.org">Documentation</a>
    ·
    <a href="https://api.openathlete.org/docs">API Docs</a>
    ·
    <a href="https://github.com/openathleteorg/openathlete/issues">Issues</a>
  </p>
</p>

<p align="center">
   <a href="https://github.com/openathleteorg/openathlete/stargazers"><img src="https://img.shields.io/github/stars/openathleteorg/openathlete" alt="Github Stars"></a>
   <a href="https://github.com/openathleteorg/openathlete/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-AGPLv3-purple" alt="License"></a>
   <a href="https://github.com/openathleteorg/openathlete/pulse"><img src="https://img.shields.io/github/commit-activity/m/openathleteorg/openathlete" alt="Commits-per-month"></a>
   <a href="https://testflight.apple.com/join/1hBg4mR1"><img src="https://img.shields.io/badge/TestFlight-iOS%20App-blue" alt="iOS App"></a>
   <a href="https://api.openathlete.org/docs"><img src="https://img.shields.io/badge/API-Swagger-green" alt="API Docs"></a>
   <a href="https://docs.openathlete.org"><img src="https://img.shields.io/badge/Docs-Online-brightgreen" alt="Documentation"></a>
   <a href="https://discord.gg/j4PP6tDwuP"><img src="https://img.shields.io/badge/Discord-Community-5865F2" alt="Discord"></a>
   <a href="https://github.com/openathleteorg/openathlete/issues?q=is:issue+is:open+label:%22help+wanted%22"><img src="https://img.shields.io/badge/Help%20Wanted-Contribute-blue"></a>
   <a href="https://github.com/openathleteorg/openathlete/issues?q=is:issue+is:open+label:%22good+first+issue%22"><img src="https://img.shields.io/badge/Good%20First%20Issue-Start%20Here-green"></a>
</p>

<!-- ABOUT THE PROJECT -->

## About the Project

# Training infrastructure that respects athletes

Endurance athletes feed years of intimate training data into proprietary U.S. platforms such as TrainingPeaks, Strava, and Garmin Connect, with little practical say in how that data is processed, monetized, or retained.

OpenAthlete is a different proposition: comparable tracking and analysis in an open-source stack, hosted in the EU when you use managed infrastructure, self-hostable when you prefer your own hardware, and with training-load logic you can read and adapt in the repository. It is maintained by an ultra-trail runner based in Grenoble.

### Key Features

- 🇪🇺 **EU-Hosted & GDPR-Native** — Data processed in the European Union
- 🔒 **You Own Your Data** — Self-hostable, open schema, no lock-in
- 🔍 **Transparent Algorithms** — Training load formulas (CTL/ATL/TSB) are in the code, auditable, customizable
- 📊 **Comprehensive Tracking** — Workouts, fitness/fatigue/form metrics, progression visualizations
- 🔗 **Activity Import** — Completed activity history and full streams from Intervals.icu
- 📱 **Mobile Apps** — Native iOS ([TestFlight](https://testflight.apple.com/join/1hBg4mR1)), Android coming
- 🌐 **Open Source** — AGPLv3, community-driven, sustainably funded

### Comparison

| Feature | 🟢 OpenAthlete | 🔵 TrainingPeaks | 🟠 Strava | 🟣 Intervals.icu |
| --- | --- | --- | --- | --- |
| **Open source code** | ✅ AGPLv3 | ❌ | ❌ | ❌ |
| **Self-hostable option** | ✅ Free | ❌ | ❌ | ❌ |
| **Data hosted in EU** | ✅ France | ❌ US | ❌ US | ⚠️ Mixed |
| **GDPR-native** | ✅ | ⚠️ | ⚠️ | ⚠️ |
| **Transparent algorithms** | ✅ Code audit | ❌ Black box | ❌ Black box | ⚠️ Partial |
| **Full data export** | ❌ Not yet | ⚠️ Limited | ⚠️ Limited | ✅ |
| **CTL/ATL/TSB tracking** | ✅ | ✅ | ❌ | ✅ |

## Recognition

OpenAthlete is built by athletes, for athletes. We're proud to be part of the open-source community and grateful for all contributors who help make this platform better.

### Built With

- [React 19](https://react.dev/) - Modern UI framework
- [NestJS](https://nestjs.com/) - Scalable Node.js backend
- [TypeScript](https://www.typescriptlang.org/) - Type-safe development
- [Prisma](https://www.prisma.io/) - Next-generation ORM
- [PostgreSQL](https://www.postgresql.org/) - Robust database
- [Tailwind CSS](https://tailwindcss.com/) - Utility-first CSS
- [ShadCN UI](https://ui.shadcn.com/) - Beautiful component library
- [Vite](https://vitejs.dev/) - Next-generation frontend tooling

<!-- ## Stay Up-to-Date

OpenAthlete is actively developed and we're constantly adding new features. Watch **releases** of this repository to be notified of future updates:

![openathlete-star-github](https://user-images.githubusercontent.com/8019099/154853944-a9e3c999-3da3-4048-b149-b4f73893c6fb.gif) -->

<!-- GETTING STARTED -->

## Getting Started

To get a local copy up and running, please follow these simple steps.

### Prerequisites

Here is what you need to be able to run OpenAthlete.

- **Node.js** (Version: >=22.14.0) - We recommend using [nvm](https://github.com/nvm-sh/nvm) for version management
- **pnpm** (Version: >=9.x) - Fast, disk space efficient package manager
- **PostgreSQL** (Version: >=13.x) - Database
- **Git** - Version control

## Development

### Setup

1. Clone the repo into a public GitHub repository (or fork https://github.com/openathleteorg/openathlete/fork):

   ```sh
   git clone https://github.com/openathleteorg/openathlete.git
   cd openathlete
   ```

2. Install packages with pnpm

   ```sh
   pnpm install
   ```

3. Set up your environment variables

   - **Frontend**: Copy `apps/web/.env.example` to `apps/web/.env` and update with your configuration
   - **Backend**: Copy `apps/api/.env.example` to `apps/api/.env` and update with your configuration
   - At minimum, you'll need:
     - `DATABASE_URL` - PostgreSQL connection string
     - `JWT_SECRET` - Secret key for JWT tokens (generate with `openssl rand -base64 32`)
     - `VITE_API_URL` - Backend API URL (for frontend)

4. Setup Node version

   If your Node version does not meet the project's requirements, use nvm:

   ```sh
   nvm use
   ```

   You first might need to install the specific version and then use it:

   ```sh
   nvm install && nvm use
   ```

5. Build shared packages

   ```sh
   pnpm shared build
   ```

6. Set up the database using Prisma

   In a development environment, run:

   ```sh
   pnpm database run db:migrate dev
   ```

   In a production environment, run:

   ```sh
   pnpm database run db:deploy
   ```

7. Run (in development mode)

   ```sh
   pnpm dev
   ```

   This will start:
   - **Frontend** at `http://localhost:5173`
   - **Backend API** at `http://localhost:3000`

### Development Tips

2. Run type checking before committing:

   ```sh
   pnpm tsc:check
   ```

2. Format and lint your code:

   ```sh
   pnpm format:write
   pnpm lint:fix
   ```

### Upgrading from earlier versions

1. Pull the current version:

   ```sh
   git pull
   ```

2. Check if dependencies got added/updated/removed

   ```sh
   pnpm install
   ```

3. Apply database migrations by running <b>one of</b> the following commands:

   In a development environment, run:

   ```sh
   pnpm database run db:migrate dev
   ```

   In a production environment, run:

   ```sh
   pnpm database run db:deploy
   ```

4. Check for `.env` variables changes

   Compare your `.env` files with the `.env.example` files to see if new variables were added.

5. Start the server. In a development environment, just do:

   ```sh
   pnpm dev
   ```

   For a production build, run for example:

   ```sh
   pnpm build
   pnpm start
   ```

6. Enjoy the new version.

<!-- DEPLOYMENT -->

## Deployment

### Docker

OpenAthlete can be deployed using Docker. Docker configurations are provided in the repository.

#### Requirements

Make sure you have `docker` & `docker compose` installed on the server / system.

#### Running OpenAthlete with Docker Compose

1. Clone the repository:

```bash
   git clone https://github.com/openathleteorg/openathlete.git
cd openathlete
   ```

2. Prepare your configuration: Copy `.env.example` files and update them:

   ```bash
   cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env
   ```

   Update the appropriate values in your `.env` files, then proceed.

3. Start OpenAthlete via docker compose:

   ```bash
   docker compose up -d
   ```

4. Open a browser to your configured URL. The first time you run OpenAthlete, you'll need to create your first user.

#### Updating OpenAthlete

1. Stop the OpenAthlete stack

   ```bash
   docker compose down
   ```

2. Pull the latest changes

   ```bash
   git pull
   ```

3. Update env vars as necessary.
4. Re-start the OpenAthlete stack

   ```bash
   docker compose up -d
   ```

### Manual Deployment

For detailed deployment instructions, see our [self-hosting documentation](https://docs.openathlete.org/docs/getting-started/self-hosting).

#### Backend (NestJS)

1. Build the application:

   ```bash
   cd apps/api
   pnpm install
   pnpm build
   ```

2. Set up environment variables in `.env`

3. Run database migrations:

   ```bash
   pnpm database run db:deploy
   ```

4. Start the server:

   ```bash
   pnpm start:prod
   ```

#### Frontend (React + Vite)

1. Build the application:

   ```bash
   cd apps/web
   pnpm install
   pnpm build
   ```

2. Serve the built files using a web server (nginx, Apache, etc.)

   Example nginx configuration:

   ```nginx
   server {
       listen 80;
       server_name your-domain.com;

       root /path/to/apps/web/dist;
       index index.html;

       location / {
           try_files $uri $uri/ /index.html;
       }
   }
   ```

### Environment Variables

#### Backend Required Variables

```properties
DATABASE_URL="postgresql://user:password@host:5432/openathlete"
JWT_SECRET="your-secret-key"
NODE_ENV="production"
```

#### Frontend Required Variables

```properties
VITE_API_URL="https://api.your-domain.com"
```

For a complete list of environment variables, see the `.env.example` files in each app directory.

## Support OpenAthlete

> OpenAthlete is built by one developer in Grenoble, supported by the community. There are three ways to help the project thrive:
>
> - **Become a Patreon supporter** — Recurring support without using the cloud. [patreon.com/OpenAthlete](https://patreon.com/OpenAthlete).
> - **Contribute code or feedback** — Star the repo, open issues, send PRs, join the [Discord](https://discord.gg/j4PP6tDwuP).
>
> Self-hosting is fully supported. Community support funds the project's long-term sustainability.

<!-- ROADMAP -->

## Roadmap

OpenAthlete is actively developed. Here's what's coming next:

- 🧩 **Modular Training Logic** - Custom goals, coach import, and flexible training methodologies
- 📈 **Enhanced Dashboards** - Intuitive data visualizations and performance analytics
- 🔗 **More Integrations** - Wahoo, Coros, Zwift, Oura, and more
- 📅 **Weekly Training View** - Better calendar and planning interface
- 📱 **Mobile App Enhancements** - Improved mobile experience and offline support

See our [GitHub Issues](https://github.com/openathleteorg/openathlete/issues) for a detailed list of proposed features and known issues.

<!-- LICENSE -->

## License

Distributed under the [AGPLv3 License](https://github.com/openathleteorg/openathlete/blob/main/LICENSE). See `LICENSE` for more information.

<!-- CONTRIBUTING -->

## Contributing

Please see our [contributing guide](/CONTRIBUTING.md).

### Good First Issues

We have a list of [good first issues](https://github.com/openathleteorg/openathlete/issues?q=is:issue+is:open+label:%22good+first+issue%22) that contain small features and bugs which have a relatively limited scope. This is a great place to get started, gain experience, and get familiar with our contribution process.

### Help Wanted

We also have [help wanted](https://github.com/openathleteorg/openathlete/issues?q=is:issue+is:open+label:%22help+wanted%22) issues that are perfect for contributors looking to make a bigger impact.

### Contributors

<a href="https://github.com/openathleteorg/openathlete/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=openathleteorg/openathlete" />
</a>

### Translations

Don't code but still want to contribute? Join our [Discord community](https://discord.gg/j4PP6tDwuP) and help translate OpenAthlete into your language.

## Repo Activity

<img width="100%" src="https://repobeats.axiom.co/api/embed/99c5ba879a6c63bdd522bb53ca2a134a080a0a4b.svg" />

<!-- ACKNOWLEDGEMENTS -->

## Acknowledgements

Special thanks to these amazing projects which help power OpenAthlete:

- [React](https://react.dev/)
- [NestJS](https://nestjs.com/)
- [TypeScript](https://www.typescriptlang.org/)
- [Prisma](https://www.prisma.io/)
- [Tailwind CSS](https://tailwindcss.com/)
- [ShadCN UI](https://ui.shadcn.com/)
- [Vite](https://vitejs.dev/)
- [PostgreSQL](https://www.postgresql.org/)

---

<p align="center">
  Made with ❤️ by athletes, for athletes
</p>
