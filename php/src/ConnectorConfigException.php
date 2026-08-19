<?php

declare(strict_types=1);

namespace ParticleAcademy\Connectors;

/**
 * A required piece of configuration is missing or unusable.
 *
 * The message must name the exact key the consumer has to set. "Stripe is not
 * configured" sends someone reading source; "no `secretKey` on the `stripe`
 * connection" sends them to the line.
 */
class ConnectorConfigException extends ConnectorException
{
    public function kind(): FailureKind
    {
        return FailureKind::Rejected;
    }
}
