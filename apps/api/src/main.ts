import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

import { ApiEnvSchemaType } from '@openathlete/shared';

import './instrument';
import { AppModule } from './modules/app.module';

async function bootstrap() {
  // Loaded lazily: the shipper pulls in axios, which binds http/https at module
  // evaluation time, and Sentry's require hook (./instrument) must be installed
  // first for outgoing requests to stay instrumented.
  const { createBetterStackLogger } = await import(
    './common/logging/better-stack.logger'
  );

  const app = await NestFactory.create(AppModule, {
    rawBody: true,
    logger: createBetterStackLogger(process.env),
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

  // Swagger configuration
  const config = new DocumentBuilder()
    .setTitle('OpenAthlete API')
    .setDescription('API documentation for OpenAthlete')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('docs', app, document);

  const port = configService.get('PORT') ?? '3000';
  await app.listen(Number.parseInt(port, 10));
}
bootstrap();
