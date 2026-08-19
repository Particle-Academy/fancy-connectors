<?php

declare(strict_types=1);

use ParticleAcademy\Connectors\ApiContract;
use ParticleAcademy\Connectors\CallContext;
use ParticleAcademy\Connectors\CallResult;
use ParticleAcademy\Connectors\CanonicalMetric;
use ParticleAcademy\Connectors\Capabilities;
use ParticleAcademy\Connectors\Connector;
use ParticleAcademy\Connectors\ContractOperation;
use ParticleAcademy\Connectors\DeliveryDeclaration;
use ParticleAcademy\Connectors\Drift;
use ParticleAcademy\Connectors\DriftFindingKind;
use ParticleAcademy\Connectors\DriftOutcome;
use ParticleAcademy\Connectors\HttpMethod;
use ParticleAcademy\Connectors\MetricDescriptor;
use ParticleAcademy\Connectors\Metrics;
use ParticleAcademy\Connectors\Probe;
use ParticleAcademy\Connectors\ProbeOutcome;
use ParticleAcademy\Connectors\ProbeSpec;
use ParticleAcademy\Connectors\RateSource;
use ParticleAcademy\Connectors\RenderRules;
use ParticleAcademy\Connectors\SpecSource;
use ParticleAcademy\Connectors\TransportException;
use ParticleAcademy\Connectors\TransportResponse;

/** A connector that claims metrics and cannot deliver them — the shipped bug. */
final class ClaimsMetricsConnector implements Connector
{
    public string $id = 'claimer';

    public string $label = 'Claimer';

    public string $provider = 'claimer';

    public Capabilities $capabilities;

    public DeliveryDeclaration $delivery;

    public ?array $metricShape = null;

    public ?RenderRules $renderRules = null;

    public function __construct()
    {
        $this->capabilities = new Capabilities(call: true, metrics: true);
        $this->delivery = new DeliveryDeclaration(false, 'no idempotency mechanism is published');
    }

    public function validate(mixed $target): array
    {
        return [];
    }

    public function call(mixed $target, CallContext $context): CallResult
    {
        return new CallResult(true, 'ref', $context->dryRun, 'ok');
    }
}

/* ── metrics ──────────────────────────────────────────────────────────────── */

it('catches a metrics capability that outruns the code', function () {
    $problems = Metrics::capabilityProblems(new ClaimsMetricsConnector);

    // A pull would ask, get nothing, and report nothing — which on a dashboard
    // is indistinguishable from "we asked and nobody engaged".
    expect($problems)->toHaveCount(2)
        ->and($problems[0])->toContain('declares no metricShape')
        ->and($problems[1])->toContain('does not implement ReportsMetrics');
});

it('catches an idempotency claim with no cited mechanism', function () {
    $connector = new ClaimsMetricsConnector;
    $connector->capabilities = new Capabilities(call: true);
    $connector->delivery = new DeliveryDeclaration(true, 'yes');

    // The one claim whose failure is a public double write.
    expect(Metrics::capabilityProblems($connector)[0])->toContain('idempotent: true with no reason');
});

it('catches a rate limit called documented that cites nothing', function () {
    $connector = new ClaimsMetricsConnector;
    $connector->capabilities = new Capabilities(call: true);
    $connector->delivery = new DeliveryDeclaration(false, 'none published', 1000, RateSource::Documented);

    expect(Metrics::capabilityProblems($connector)[0])->toContain('cites nothing');
});

it('compares a declared shape against what the mapping produces', function () {
    $declared = [
        new MetricDescriptor('likes', 'Likes', CanonicalMetric::Like, 'people who liked the post'),
        new MetricDescriptor('quotes', 'Quotes', null, 'people who quoted the post'),
    ];

    expect(Metrics::compareShape('x', $declared, ['likes' => 1, 'quotes' => 2]))->toBeNull();

    $mismatch = Metrics::compareShape('x', $declared, ['likes' => 1, 'reposts' => 3]);

    expect($mismatch->undeclared)->toBe(['reposts'])
        ->and($mismatch->unproduced)->toBe(['quotes']);
});

it('keeps absent absent', function () {
    // A zero says "nothing happened"; an absence says "we don't know". A
    // measurement surface that confuses those is worthless, and the confusion
    // is one `?? 0` away.
    expect(Metrics::reported(['likes' => 0, 'shares' => null, 'views' => '12', 'replies' => 3]))
        ->toBe(['likes' => 0, 'replies' => 3]);
});

/* ── drift ────────────────────────────────────────────────────────────────── */

$contract = new ApiContract(
    connector: 'example',
    spec: SpecSource::openapi('https://example.test/openapi.json'),
    operations: [
        new ContractOperation('charge_create', HttpMethod::Post, '/v1/charges', ['amount'], ['id', 'status']),
    ],
    reviewedOn: gmdate('Y-m-d'),
);

$spec = [
    'paths' => [
        '/v1/charges' => [
            'post' => [
                'requestBody' => ['content' => ['application/json' => ['schema' => ['$ref' => '#/components/schemas/ChargeRequest']]]],
                'responses' => ['200' => ['content' => ['application/json' => ['schema' => ['$ref' => '#/components/schemas/Charge']]]]],
            ],
        ],
    ],
    'components' => [
        'schemas' => [
            'ChargeRequest' => ['properties' => ['amount' => [], 'currency' => []]],
            'Charge' => ['properties' => ['id' => [], 'status' => []]],
        ],
    ],
];

it('reports clean when the spec still carries everything the connector uses', function () use ($contract, $spec) {
    $report = Drift::checkAgainstOpenApi($contract, $spec);

    expect($report->outcome)->toBe(DriftOutcome::Clean)
        ->and($report->findings)->toBe([]);
});

it('does not treat an ADDED field as drift', function () use ($contract, $spec) {
    // A provider adding fields is normal and healthy. Reporting it would bury
    // the one line that matters under every additive release.
    $spec['components']['schemas']['Charge']['properties']['receipt_url'] = [];

    expect(Drift::checkAgainstOpenApi($contract, $spec)->outcome)->toBe(DriftOutcome::Clean);
});

it('reports a removed RESPONSE field as the silent kind', function () use ($contract, $spec) {
    unset($spec['components']['schemas']['Charge']['properties']['status']);

    $report = Drift::checkAgainstOpenApi($contract, $spec);

    expect($report->outcome)->toBe(DriftOutcome::Drifted)
        ->and($report->findings[0]->kind)->toBe(DriftFindingKind::MissingResponseField)
        ->and($report->findings[0]->detail)->toContain('silent kind');
});

it('reports a vanished path as a missing operation', function () use ($contract) {
    $report = Drift::checkAgainstOpenApi($contract, ['paths' => ['/v2/charges' => ['post' => []]]]);

    expect($report->findings[0]->kind)->toBe(DriftFindingKind::MissingOperation);
});

it('never follows a REMOTE ref', function () use ($contract, $spec) {
    // Fetching arbitrary URLs out of a document we do not control, on a
    // schedule, with nobody watching, is a request-forgery surface.
    $spec['paths']['/v1/charges']['post']['responses']['200']['content']['application/json']['schema'] =
        ['$ref' => 'https://evil.example.test/schema.json'];

    // The unresolvable ref yields no properties, which reads as "we could not
    // read it" rather than "the field is gone" — so nothing is reported.
    expect(Drift::checkAgainstOpenApi($contract, $spec)->outcome)->toBe(DriftOutcome::Clean);
});

it('reports an unreadable document as UNCHECKED, never clean', function () use ($contract) {
    $report = Drift::checkAgainstOpenApi($contract, ['swagger' => '2.0']);

    expect($report->outcome)->toBe(DriftOutcome::Unchecked)
        ->and($report->findings[0]->kind)->toBe(DriftFindingKind::UnreadableSpec);
});

it('reports a stale review without calling it drift', function () use ($spec) {
    $stale = new ApiContract(
        connector: 'example',
        spec: SpecSource::openapi('https://example.test/openapi.json'),
        operations: [new ContractOperation('charge_create', HttpMethod::Post, '/v1/charges', ['amount'], ['id', 'status'])],
        reviewedOn: '2019-01-01',
    );

    $report = Drift::checkAgainstOpenApi($stale, $spec);

    expect($report->outcome)->toBe(DriftOutcome::Clean, 'an absence of looking is not an API change')
        ->and($report->findings[0]->kind)->toBe(DriftFindingKind::StaleReview);
});

it('flattens a response shape with arrays collapsed to one element', function () {
    // Recording `items.0.id`, `items.1.id`… would make the fixture depend on how
    // much data the account happened to have that day.
    expect(Drift::shapeOf(['data' => [['id' => 1, 'name' => 'a'], ['id' => 2, 'name' => 'b']]]))
        ->toBe(['data[].id', 'data[].name']);
});

it('matches a dotted read against an array-bearing shape', function () {
    $contract = new ApiContract(
        connector: 'example',
        spec: SpecSource::none('the provider publishes no machine-readable description at any stable URL'),
        operations: [new ContractOperation('list', HttpMethod::Get, '/things', [], ['data.id'])],
        reviewedOn: gmdate('Y-m-d'),
    );

    expect(Drift::checkAgainstRecordedShape($contract, 'list', ['data' => [['id' => 1]]])->outcome)
        ->toBe(DriftOutcome::Clean);

    expect(Drift::checkAgainstRecordedShape($contract, 'list', ['data' => [['ref' => 1]]])->outcome)
        ->toBe(DriftOutcome::Drifted);
});

it('refuses a spec source of "none" with no reason', function () {
    // A `none` with no note is indistinguishable from nobody having looked, and
    // those need opposite actions.
    expect(fn () => SpecSource::none('  '))->toThrow(InvalidArgumentException::class);
});

it('reports a provider that publishes nothing as unchecked', function () {
    $contract = new ApiContract(
        connector: 'example',
        spec: SpecSource::none('the provider ships an SDK and no spec; the fallback is a recorded shape'),
        operations: [],
        reviewedOn: gmdate('Y-m-d'),
    );

    $report = Drift::unchecked($contract);

    expect($report->outcome)->toBe(DriftOutcome::Unchecked)
        ->and($report->findings[0]->detail)->toContain('ships an SDK');
});

/* ── probes ───────────────────────────────────────────────────────────────── */

it('passes on the auth-shaped refusal the provider declared', function () {
    $result = Probe::run(new ProbeSpec(
        connector: 'discord',
        request: static fn (): TransportResponse => new TransportResponse(404, [], 'Unknown Webhook'),
        authStatuses: [404],
        why: 'Discord answers 404 for an unknown webhook id, so 404 IS its auth answer.',
    ));

    expect($result->outcome)->toBe(ProbeOutcome::Pass);
});

it('FAILS when the provider accepts a credential that cannot be valid', function () {
    // Worse than a failure, because it is green: either the credential is
    // reaching nothing or the endpoint does not authenticate.
    $result = Probe::run(new ProbeSpec(
        connector: 'example',
        request: static fn (): TransportResponse => new TransportResponse(200, [], '{}'),
        authStatuses: [401],
        why: 'a bearer token is checked on every route',
    ));

    expect($result->outcome)->toBe(ProbeOutcome::Fail)
        ->and($result->detail)->toContain('ACCEPTED a deliberately invalid credential');
});

it('fails an unexpected status, because the endpoint probably moved', function () {
    $result = Probe::run(new ProbeSpec(
        connector: 'example',
        request: static fn (): TransportResponse => new TransportResponse(404, [], 'not found'),
        authStatuses: [401],
        why: 'a bearer token is checked on every route',
    ));

    expect($result->outcome)->toBe(ProbeOutcome::Fail)
        ->and($result->detail)->toContain('endpoint moved');
});

it('SKIPS when the machine is offline, rather than going red', function () {
    // A check that goes red on a train gets ignored, and is then worth nothing
    // when it goes red for real.
    $report = Probe::runProbes([
        new ProbeSpec(
            connector: 'example',
            request: static fn (): never => throw TransportException::fromCurlErrno(6, 'could not resolve host'),
            authStatuses: [401],
            why: 'a bearer token is checked on every route',
        ),
    ]);

    expect($report->results[0]->outcome)->toBe(ProbeOutcome::Skip)
        ->and($report->skipped)->toBe(1)
        ->and($report->ok())->toBeTrue('a skip does not fail a report');
});

it('never throws out of a probe, whatever the request did', function () {
    $result = Probe::run(new ProbeSpec(
        connector: 'example',
        request: static fn (): never => throw new LogicException('exploded'),
        authStatuses: [401],
        why: 'a bearer token is checked on every route',
    ));

    expect($result->outcome)->toBe(ProbeOutcome::Fail);
});
