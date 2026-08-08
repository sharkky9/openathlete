import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { ApiEnvSchemaType, ENV } from '@openathlete/shared';

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

  // Railway terminates TLS in front of the app, so without this every request
  // carries the proxy's IP and all clients would share a single throttle bucket.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  const port = configService.get('PORT') ?? '3000';
  await app.listen(Number.parseInt(port, 10));
}
bootstrap();
