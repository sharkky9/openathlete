import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { ApiEnvSchemaType, ENV } from '@openathlete/shared';

import { configureTrustProxy } from './common/utils/client-ip.util';
import './instrument';
import { AppModule } from './modules/app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
  });

  const configService = app.get(ConfigService<ApiEnvSchemaType, true>);
  const corsOrigins = configService.get('CORS_ORIGINS');
  const allowedOrigins = corsOrigins
    ? corsOrigins.split(',')
    : ['http://localhost:5173'];

  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // Swagger configuration. Kept off in production: /docs is unauthenticated and
  // enumerates every route, payload shape and auth requirement of the API.
  // Gate on ENV (the app's own environment), not NODE_ENV — production builds
  // are also what staging and the deployment smoke test run.
  if (configService.get('ENV') !== ENV.PROD) {
    const config = new DocumentBuilder()
      .setTitle('OpenAthlete API')
      .setDescription('API documentation for OpenAthlete')
      .setVersion('1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('docs', app, document);
  }

  // Railway terminates TLS in front of the app, so the client address only
  // exists in `X-Forwarded-For`. This trusts every hop and takes the leftmost
  // entry — correct only because Railway's edge strips the caller's own header
  // and writes the real address. Without such a proxy in front, callers could
  // forge that entry and bypass the throttle outright. See client-ip.util.ts.
  configureTrustProxy(app);

  const port = configService.get('PORT') ?? '3000';
  await app.listen(Number.parseInt(port, 10));
}
bootstrap();
