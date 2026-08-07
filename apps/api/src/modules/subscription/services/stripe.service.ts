import Stripe from 'stripe';

import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { SubscriptionPlan } from '@openathlete/shared';
import { ApiEnvSchemaType } from '@openathlete/shared';

@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private readonly stripe: Stripe | null;
  private readonly priceIds: Record<SubscriptionPlan, string>;

  constructor(
    private readonly configService: ConfigService<ApiEnvSchemaType, true>,
  ) {
    const secretKey = this.configService.get('STRIPE_SECRET_KEY');

    // Payments are optional. Without a secret key the service still registers
    // so the DI graph (and everything that depends on SubscriptionModule, such
    // as FeatureAccessGuard) keeps working; the billing calls themselves fail
    // at request time via `client` instead of crashing the app at boot.
    this.stripe = secretKey
      ? new Stripe(secretKey, { apiVersion: '2025-11-17.clover' })
      : null;

    if (!this.stripe) {
      this.logger.warn(
        'STRIPE_SECRET_KEY is not set — payment features are disabled.',
      );
    }

    const priceIdsJson = this.configService.get('STRIPE_PRICE_IDS');
    if (!priceIdsJson) {
      this.priceIds = {
        [SubscriptionPlan.FREE]: '',
        [SubscriptionPlan.ATHLETE_PRO]: '',
        [SubscriptionPlan.COACH_PRO]: '',
        [SubscriptionPlan.COACH_ULTRA]: '',
        [SubscriptionPlan.CLUB_PRO]: '',
        [SubscriptionPlan.CLUB_ULTRA]: '',
      };
      return;
    }

    try {
      this.priceIds = JSON.parse(priceIdsJson) as Record<
        SubscriptionPlan,
        string
      >;
    } catch (error) {
      this.logger.error(
        `Failed to parse STRIPE_PRICE_IDS: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
      this.logger.error('Price IDs: %j', priceIdsJson);
      this.priceIds = {
        [SubscriptionPlan.FREE]: '',
        [SubscriptionPlan.ATHLETE_PRO]: '',
        [SubscriptionPlan.COACH_PRO]: '',
        [SubscriptionPlan.COACH_ULTRA]: '',
        [SubscriptionPlan.CLUB_PRO]: '',
        [SubscriptionPlan.CLUB_ULTRA]: '',
      };
    }
  }

  /**
   * Whether payment processing is configured for this deployment.
   */
  get isConfigured(): boolean {
    return this.stripe !== null;
  }

  /**
   * The Stripe client, or a 503 if payments were never configured.
   * Every call that actually talks to Stripe must go through this.
   */
  private get client(): Stripe {
    if (!this.stripe) {
      throw new ServiceUnavailableException(
        'Payments are not configured on this deployment (STRIPE_SECRET_KEY is not set).',
      );
    }
    return this.stripe;
  }

  /**
   * Create or retrieve a Stripe customer for a user
   */
  async getOrCreateCustomer(
    userId: number,
    email: string,
  ): Promise<Stripe.Customer> {
    // Try to find existing customer by metadata
    const existingCustomers = await this.client.customers.list({
      email,
      limit: 1,
    });

    if (existingCustomers.data.length > 0) {
      const customer = existingCustomers.data[0];
      // Verify it's the right customer by checking metadata
      if (customer.metadata?.userId === userId.toString()) {
        return customer;
      }
    }

    // Create new customer
    const customer = await this.client.customers.create({
      email,
      metadata: {
        userId: userId.toString(),
      },
    });

    return customer;
  }

  /**
   * Retrieve a Stripe customer by ID without throwing when it was deleted.
   * Callers that need to distinguish the deleted case handle it themselves.
   */
  async retrieveCustomer(
    customerId: string,
  ): Promise<Stripe.Response<Stripe.Customer | Stripe.DeletedCustomer>> {
    return await this.client.customers.retrieve(customerId);
  }

  /**
   * Retrieve a Stripe customer by ID
   */
  async getCustomer(customerId: string): Promise<Stripe.Customer> {
    const customer = await this.client.customers.retrieve(customerId);
    if (customer.deleted || !('metadata' in customer)) {
      throw new Error(`Customer not found or deleted: ${customerId}`);
    }
    return customer;
  }

  async hasUsedTrial(customerId: string): Promise<boolean> {
    const subscriptions = await this.client.subscriptions.list({
      customer: customerId,
      limit: 100,
      status: 'all', // Include all statuses (active, canceled, past_due, etc.)
    });

    for (const subscription of subscriptions.data) {
      if (subscription.trial_end && subscription.trial_end > 0) {
        return true;
      }
    }

    return false;
  }

  /**
   * Create a checkout session for subscription
   */
  async createCheckoutSession(
    customerId: string,
    plan: SubscriptionPlan,
    successUrl: string,
    cancelUrl: string,
  ): Promise<Stripe.Checkout.Session> {
    const priceId = this.priceIds[plan];
    if (!priceId) {
      throw new Error(`Price ID not found for plan: ${plan}`);
    }

    // Check if plan is paid (not FREE)
    const isPaidPlan = plan !== SubscriptionPlan.FREE;

    // Check if customer has already used a trial
    const hasUsedTrial = isPaidPlan
      ? await this.hasUsedTrial(customerId)
      : false;

    // Calculate trial end date (15 days from now) if applicable
    const trialEndDate =
      isPaidPlan && !hasUsedTrial
        ? Math.floor(Date.now() / 1000) + 15 * 24 * 60 * 60 // 15 days in seconds
        : undefined;

    const sessionConfig: Stripe.Checkout.SessionCreateParams = {
      customer: customerId,
      mode: 'subscription',
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        plan,
      },
      subscription_data: {
        metadata: {
          plan,
        },
      },
    };

    if (trialEndDate) {
      sessionConfig.subscription_data = {
        ...sessionConfig.subscription_data,
        trial_end: trialEndDate,
      };
    }

    const session = await this.client.checkout.sessions.create(sessionConfig);

    return session;
  }

  /**
   * Create customer portal session
   */
  async createCustomerPortalSession(
    customerId: string,
    returnUrl: string,
  ): Promise<Stripe.BillingPortal.Session> {
    const session = await this.client.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });

    return session;
  }

  /**
   * Get customer invoices
   */
  async getCustomerInvoices(
    customerId: string,
    limit = 10,
  ): Promise<Stripe.Invoice[]> {
    const invoices = await this.client.invoices.list({
      customer: customerId,
      limit,
    });

    return invoices.data;
  }

  /**
   * Get plan from price ID (reverse lookup)
   */
  getPlanFromPriceId(priceId: string): SubscriptionPlan {
    // Reverse lookup: find which plan has this price ID
    for (const [plan, id] of Object.entries(this.priceIds)) {
      if (id === priceId) {
        return plan as SubscriptionPlan;
      }
    }
    // If not found, return FREE as fallback
    this.logger.warn(
      `Price ID ${priceId} not found in priceIds mapping, defaulting to FREE`,
    );
    return SubscriptionPlan.FREE;
  }

  /**
   * Get subscription by ID
   */
  async getSubscription(
    subscriptionId: string,
  ): Promise<Stripe.Subscription | null> {
    try {
      // Expand items to get price information
      return await this.client.subscriptions.retrieve(subscriptionId, {
        expand: ['items.data.price'],
      });
    } catch (error) {
      if (
        error instanceof Stripe.errors.StripeError &&
        error.statusCode === 404
      ) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Cancel subscription at period end
   */
  async cancelSubscriptionAtPeriodEnd(
    subscriptionId: string,
  ): Promise<Stripe.Subscription> {
    return await this.client.subscriptions.update(subscriptionId, {
      cancel_at_period_end: true,
    });
  }

  /**
   * Resume subscription (remove cancellation)
   */
  async resumeSubscription(
    subscriptionId: string,
  ): Promise<Stripe.Subscription> {
    return await this.client.subscriptions.update(subscriptionId, {
      cancel_at_period_end: false,
    });
  }

  /**
   * Update subscription to a new plan
   */
  async updateSubscriptionPlan(
    subscriptionId: string,
    newPlan: SubscriptionPlan,
  ): Promise<Stripe.Subscription> {
    const subscription = await this.getSubscription(subscriptionId);
    if (!subscription) {
      throw new Error('Subscription not found');
    }

    const newPriceId = this.priceIds[newPlan];
    if (!newPriceId) {
      throw new Error(`Price ID not found for plan: ${newPlan}`);
    }

    // Update subscription with proration
    return await this.client.subscriptions.update(subscriptionId, {
      items: [
        {
          id: subscription.items.data[0].id,
          price: newPriceId,
        },
      ],
      proration_behavior: 'always_invoice',
      metadata: {
        plan: newPlan,
      },
    });
  }

  /**
   * Verify webhook signature
   */
  verifyWebhookSignature(
    payload: string | Buffer,
    signature: string,
  ): Stripe.Event {
    const webhookSecret = this.configService.get('STRIPE_WEBHOOK_SECRET');
    if (!webhookSecret) {
      throw new Error('STRIPE_WEBHOOK_SECRET is not set');
    }

    return this.client.webhooks.constructEvent(
      payload,
      signature,
      webhookSecret,
    );
  }
}
