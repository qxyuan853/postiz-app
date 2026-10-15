import 'reflect-metadata';
import Stripe from 'stripe';
import { StripeService } from '@gitroom/nestjs-libraries/services/stripe.service';
import { pricing } from '@gitroom/nestjs-libraries/database/prisma/subscriptions/pricing';

jest.mock('stripe', () => {
  const api = {
    customers: { create: jest.fn(), update: jest.fn() },
    subscriptions: { list: jest.fn(), update: jest.fn() },
    products: { list: jest.fn(), create: jest.fn() },
    prices: { list: jest.fn(), create: jest.fn() },
    promotionCodes: { list: jest.fn() },
    checkout: { sessions: { create: jest.fn() } },
    billingPortal: { sessions: { create: jest.fn() } },
  };
  return jest.fn(() => api);
});
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/subscriptions/subscription.service',
  () => ({ SubscriptionService: class {} })
);
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service',
  () => ({ OrganizationService: class {} })
);
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/users/users.service',
  () => ({ UsersService: class {} })
);
jest.mock('@gitroom/nestjs-libraries/track/track.service', () => ({
  TrackService: class {},
}));
jest.mock('@gitroom/helpers/auth/auth.service', () => ({ AuthService: {} }));

// The mocked constructor always hands back the same object the service holds.
const stripe = new (Stripe as any)() as any;

const organizationId = 'org-1';
const userId = 'user-1';
const uniqueId = 'unique-1';

// Fields the client may send when subscribing, plus keys that are not part of
// BillingSubscribeDto (the global ValidationPipe does not strip them).
const requestBody = (): any => ({
  billing: 'PRO',
  period: 'YEARLY',
  utm: 'newsletter',
  dub: '',
  datafast_session_id: 'ds-1',
  datafast_visitor_id: 'dv-1',
  service: 'not-gitroom',
  userId: 'someone-else',
  somethingElse: 'x',
});

describe('StripeService subscription metadata', () => {
  const subscriptionService = {
    getSubscription: jest.fn(),
  };
  const organizationService = {
    getOrgById: jest.fn(),
  };
  const userService = {
    getUserById: jest.fn(),
  };
  let service: StripeService;

  beforeEach(() => {
    jest.clearAllMocks();

    organizationService.getOrgById.mockResolvedValue({
      id: organizationId,
      paymentId: 'cus_1',
    });
    userService.getUserById.mockResolvedValue({ email: 'user@example.com' });
    subscriptionService.getSubscription.mockResolvedValue(null);

    stripe.products.list.mockResolvedValue({
      data: [{ id: 'prod_1', name: 'PRO' }],
    });
    stripe.prices.list.mockResolvedValue({
      data: [
        {
          id: 'price_1',
          recurring: { interval: 'year' },
          unit_amount: pricing.PRO.year_price * 100,
        },
      ],
    });
    stripe.subscriptions.list.mockResolvedValue({ data: [] });
    stripe.customers.update.mockResolvedValue({});
    stripe.checkout.sessions.create.mockResolvedValue({
      client_secret: 'secret',
      url: 'https://checkout.example.com/session',
    });
    stripe.subscriptions.update.mockResolvedValue({});

    service = new StripeService(
      subscriptionService as any,
      organizationService as any,
      userService as any,
      {} as any
    );
  });

  const checkoutMetadata = () =>
    stripe.checkout.sessions.create.mock.calls[0][0].subscription_data.metadata;

  const expectServerOwnedMetadata = (metadata: Record<string, unknown>) => {
    expect(metadata.service).toBe('gitroom');
    expect(metadata.userId).toBe(userId);
    expect(metadata.uniqueId).toEqual(expect.any(String));
    expect(metadata.ud).toBe(uniqueId);
  };

  const expectClientFieldsOnly = (metadata: Record<string, unknown>) => {
    expect(metadata).toMatchObject({
      billing: 'PRO',
      period: 'YEARLY',
      utm: 'newsletter',
      datafast_session_id: 'ds-1',
      datafast_visitor_id: 'dv-1',
    });
    expect(metadata).not.toHaveProperty('somethingElse');
  };

  it('embedded checkout keeps server-owned metadata and drops unknown body fields', async () => {
    await service.embedded(
      uniqueId,
      organizationId,
      userId,
      requestBody(),
      false
    );

    const metadata = checkoutMetadata();
    expectServerOwnedMetadata(metadata);
    expectClientFieldsOnly(metadata);
  });

  it('hosted checkout keeps server-owned metadata and drops unknown body fields', async () => {
    await service.subscribe(
      uniqueId,
      organizationId,
      userId,
      requestBody(),
      false
    );

    const metadata = checkoutMetadata();
    expectServerOwnedMetadata(metadata);
    expectClientFieldsOnly(metadata);
  });

  it('plan change on an existing subscription keeps server-owned metadata and drops unknown body fields', async () => {
    subscriptionService.getSubscription.mockResolvedValue({ id: 'sub-row' });
    stripe.subscriptions.list.mockResolvedValue({
      data: [
        {
          id: 'sub_1',
          status: 'active',
          items: { data: [{ id: 'si_1' }] },
        },
      ],
    });

    await service.subscribe(
      uniqueId,
      organizationId,
      userId,
      requestBody(),
      false
    );

    expect(stripe.checkout.sessions.create).not.toHaveBeenCalled();
    const [subscriptionId, update] = stripe.subscriptions.update.mock.calls[0];
    expect(subscriptionId).toBe('sub_1');
    expect(update.metadata.service).toBe('gitroom');
    expect(update.metadata.userId).toBe(userId);
    expect(update.metadata.ud).toBe(uniqueId);
    expectClientFieldsOnly(update.metadata);
  });
});
