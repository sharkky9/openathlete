import {
  useDisconnectProviderMutation,
  useGetConnectedProvidersQuery,
} from '@/api/provider';
import { ApiKeyConnectDialog } from '@/components/connectors/api-key-connect-dialog';
import { SUPPORTED_CONNECTOR_PROVIDERS } from '@/components/connectors/api-key-providers';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { m } from '@/paraglide/messages';
import {
  AnalyticsEvent,
  type OauthConnectSource,
} from '@/utils/analytics-events';
import { connectorProviderLabelMap } from '@/utils/label-map/core/connector-provider.label-map';
import { CheckCircle2, Link2, Link2Off } from 'lucide-react';
import { usePostHog } from 'posthog-js/react';
import { useState } from 'react';
import { toast } from 'sonner';

import { ConnectorProvider } from '@openathlete/shared';

interface ConnectorsListProps {
  showSkip?: boolean;
  onSkip?: () => void;
  /** Where OAuth was started (for PostHog funnel). */
  oauthConnectSource?: OauthConnectSource;
}

export function ConnectorsList({
  showSkip = false,
  onSkip,
  oauthConnectSource = 'settings',
}: ConnectorsListProps) {
  const posthog = usePostHog();
  const [apiKeyProvider, setApiKeyProvider] =
    useState<ConnectorProvider | null>(null);
  const { data: connectedProviders = [], isLoading: isLoadingConnected } =
    useGetConnectedProvidersQuery();

  const disconnectMutation = useDisconnectProviderMutation({
    onSuccess: (_, provider) => {
      posthog?.capture('provider_disconnected', {
        provider,
        source: oauthConnectSource,
      });
      toast.success(
        m.disconnected_from_provider({
          provider: connectorProviderLabelMap[provider],
        }),
      );
    },
    onError: (error) => {
      toast.error(error.message || m.failed_to_disconnect());
    },
  });

  const isConnected = (provider: ConnectorProvider) => {
    return connectedProviders.some((p) => p.provider === provider);
  };

  const handleConnect = (provider: ConnectorProvider) => {
    setApiKeyProvider(provider);
  };

  const handleDisconnect = (provider: ConnectorProvider) => {
    disconnectMutation.mutate(provider);
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-4">
        {isLoadingConnected
          ? Array.from({ length: SUPPORTED_CONNECTOR_PROVIDERS.length }).map(
              (_, i) => (
                <Card key={i}>
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <Skeleton className="h-10 w-10 rounded" />
                        <div>
                          <Skeleton className="h-5 w-32 mb-2" />
                          <Skeleton className="h-4 w-24" />
                        </div>
                      </div>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <Skeleton className="h-10 w-full" />
                  </CardContent>
                </Card>
              ),
            )
          : SUPPORTED_CONNECTOR_PROVIDERS.map((provider) => {
              const connected = isConnected(provider);
              const isLoading =
                disconnectMutation.isPending || isLoadingConnected;

              return (
                <Card key={provider}>
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="h-10 w-10 flex items-center justify-center">
                          <Link2 className="h-5 w-5" />
                        </div>
                        <div>
                          <CardTitle className="text-base">
                            {connectorProviderLabelMap[provider]}
                          </CardTitle>
                          <CardDescription>
                            {connected
                              ? m.connected_and_syncing()
                              : m.not_connected()}
                          </CardDescription>
                        </div>
                      </div>
                      {connected && (
                        <div className="flex items-center gap-2 text-green-600 dark:text-green-400">
                          <CheckCircle2 className="h-5 w-5" />
                          <span className="text-sm font-medium">
                            {m.connected()}
                          </span>
                        </div>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-center justify-between">
                      <div className="flex-1">
                        {connected ? (
                          <p className="text-sm text-muted-foreground">
                            {m.provider_account_connected({
                              provider: connectorProviderLabelMap[provider],
                            })}
                          </p>
                        ) : (
                          <p className="text-sm text-muted-foreground">
                            {m.connect_provider_account({
                              provider: connectorProviderLabelMap[provider],
                            })}
                          </p>
                        )}
                      </div>
                      <div className="ml-4">
                        {connected ? (
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => handleDisconnect(provider)}
                            disabled={isLoading}
                          >
                            <Link2Off className="h-4 w-4 mr-2" />
                            {m.disconnect()}
                          </Button>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleConnect(provider)}
                            disabled={isLoading}
                          >
                            <Link2 className="h-4 w-4 mr-2" />
                            {m.connect()}
                          </Button>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
      </div>
      {showSkip && onSkip && (
        <Button variant="ghost" onClick={onSkip} className="w-full">
          {m.onboarding_connectors_skip()}
        </Button>
      )}
      <ApiKeyConnectDialog
        provider={apiKeyProvider}
        onOpenChange={(open) => {
          if (!open) setApiKeyProvider(null);
        }}
        onConnected={(provider) => {
          posthog?.capture(AnalyticsEvent.provider_connect_initiated, {
            provider,
            source: oauthConnectSource,
          });
        }}
      />
    </div>
  );
}
