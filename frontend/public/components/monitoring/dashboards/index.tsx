import * as _ from 'lodash-es';
import { Button, Dropdown, DropdownToggle, DropdownItem } from '@patternfly/react-core';
import { AngleDownIcon, AngleRightIcon } from '@patternfly/react-icons';
import * as React from 'react';
import { Helmet } from 'react-helmet';
import { useTranslation } from 'react-i18next';
// eslint-disable-next-line @typescript-eslint/ban-ts-ignore
// @ts-ignore
import { connect, useDispatch } from 'react-redux';
import { Map as ImmutableMap } from 'immutable';

import { RedExclamationCircleIcon } from '@console/shared';
import ErrorAlert from '@console/shared/src/components/alerts/error';
import Dashboard from '@console/shared/src/components/dashboard/Dashboard';
import DashboardCard from '@console/shared/src/components/dashboard/dashboard-card/DashboardCard';
import DashboardCardBody from '@console/shared/src/components/dashboard/dashboard-card/DashboardCardBody';
import DashboardCardHeader from '@console/shared/src/components/dashboard/dashboard-card/DashboardCardHeader';
import DashboardCardLink from '@console/shared/src/components/dashboard/dashboard-card/DashboardCardLink';
import DashboardCardTitle from '@console/shared/src/components/dashboard/dashboard-card/DashboardCardTitle';
import { withFallback } from '@console/shared/src/components/error/error-boundary';

import * as UIActions from '../../../actions/ui';
import { ErrorBoundaryFallback } from '../../error';
import { RootState } from '../../../redux';
import { getPrometheusURL, PrometheusEndpoint } from '../../graphs/helpers';
import { ExternalLink, history, LoadingInline, useSafeFetch } from '../../utils';
import { formatPrometheusDuration, parsePrometheusDuration } from '../../utils/datetime';
import IntervalDropdown from '../poll-interval-dropdown';
import BarChart from './bar-chart';
import Graph from './graph';
import SingleStat from './single-stat';
import Table from './table';
import { MONITORING_DASHBOARDS_DEFAULT_TIMESPAN, Panel } from './types';

const NUM_SAMPLES = 30;

const evaluateTemplate = (s: string, variables: VariablesMap, timespan: number): string => {
  if (_.isEmpty(s)) {
    return undefined;
  }

  // Handle the special `$__interval` and `$__rate_interval` variables
  const intervalMS = timespan / NUM_SAMPLES;
  const intervalMinutes = Math.floor(intervalMS / 1000 / 60);
  // Use a minimum of 5m to make sure we have enough data to perform `irate` calculations, which
  // require 2 data points each. Otherwise, there could be gaps in the graph.
  const interval: Variable = { value: `${Math.max(intervalMinutes, 5)}m` };
  const allVariables = {
    ...variables,
    __interval: interval,
    // eslint-disable-next-line camelcase
    __rate_interval: interval,

    // This is last to ensure it is applied after all other variable substitutions (because the
    // other variable substitutions may result in "$__auto_interval_*" being inserted)
    '__auto_interval_[a-z]+': interval,
  };

  let result = s;
  _.each(allVariables, (v, k) => {
    const re = new RegExp(`\\$${k}`, 'g');
    if (result.match(re)) {
      if (v.isLoading) {
        result = undefined;
        return false;
      }
      result = result.replace(re, v.value || '');
    }
  });

  return result;
};

const useBoolean = (initialValue: boolean): [boolean, () => void, () => void, () => void] => {
  const [value, setValue] = React.useState(initialValue);
  const toggle = React.useCallback(() => setValue((v) => !v), []);
  const setTrue = React.useCallback(() => setValue(true), []);
  const setFalse = React.useCallback(() => setValue(false), []);
  return [value, toggle, setTrue, setFalse];
};

const VariableDropdown: React.FC<VariableDropdownProps> = ({
  id,
  isError = false,
  items,
  label,
  onChange,
  selectedKey,
}) => {
  const { t } = useTranslation();

  const [isOpen, toggleIsOpen, , setClosed] = useBoolean(false);

  return (
    <div className="form-group monitoring-dashboards__dropdown-wrap">
      <label htmlFor={`${id}-dropdown`} className="monitoring-dashboards__dropdown-title">
        {label}
      </label>
      {isError ? (
        <Dropdown
          toggle={
            <DropdownToggle
              className="monitoring-dashboards__dropdown-button"
              id={`${id}-dropdown`}
              isDisabled={true}
            >
              <RedExclamationCircleIcon /> {t('public~Error loading options')}
            </DropdownToggle>
          }
        />
      ) : (
        <Dropdown
          dropdownItems={_.map(items, (name, key) => (
            <DropdownItem component="button" key={key} onClick={() => onChange(key)}>
              {name}
            </DropdownItem>
          ))}
          isOpen={isOpen}
          onSelect={setClosed}
          toggle={
            <DropdownToggle
              className="monitoring-dashboards__dropdown-button"
              id={`${id}-dropdown`}
              onToggle={toggleIsOpen}
            >
              {items[selectedKey]}
            </DropdownToggle>
          }
          className="monitoring-dashboards__variable-dropdown"
        />
      )}
    </div>
  );
};

const SingleVariableDropdown_: React.FC<SingleVariableDropdownProps> = ({
  id,
  isHidden,
  name,
  options,
  optionsLoaded,
  patchVariable,
  query,
  timespan,
  value,
}) => {
  const safeFetch = React.useCallback(useSafeFetch(), []);

  const [isError, setIsError] = React.useState(false);

  React.useEffect(() => {
    if (query) {
      // Convert label_values queries to something Prometheus can handle
      // TODO: Once the Prometheus /series endpoint is available through the API proxy, this should
      // be converted to use that instead
      const prometheusQuery = query.replace(/label_values\((.*), (.*)\)/, 'count($1) by ($2)');

      const url = getPrometheusURL({
        endpoint: PrometheusEndpoint.QUERY_RANGE,
        query: prometheusQuery,
        samples: NUM_SAMPLES,
        timeout: '30s',
        timespan,
      });

      patchVariable(name, { isLoading: true });

      safeFetch(url)
        .then(({ data }) => {
          setIsError(false);
          const newOptions = _.flatMap(data?.result, ({ metric }) => _.values(metric)).sort();
          optionsLoaded(name, newOptions);
        })
        .catch((err) => {
          patchVariable(name, { isLoading: false });
          if (err.name !== 'AbortError') {
            setIsError(true);
          }
        });
    }
  }, [name, patchVariable, query, safeFetch, optionsLoaded, timespan]);

  const onChange = React.useCallback((v: string) => patchVariable(name, { value: v }), [
    name,
    patchVariable,
  ]);

  if (isHidden || (!isError && _.isEmpty(options))) {
    return null;
  }

  return (
    <VariableDropdown
      id={id}
      isError={isError}
      items={_.zipObject(options, options)}
      label={name}
      onChange={onChange}
      selectedKey={value}
    />
  );
};
const SingleVariableDropdown = connect(
  ({ UI }: RootState, { name }: { name: string }) => {
    const variables = UI.getIn(['monitoringDashboards', 'variables']).toJS();
    const timespan = UI.getIn(['monitoringDashboards', 'timespan']);
    const { isHidden, options, query, value } = variables[name] ?? {};
    return {
      isHidden,
      options,
      query: evaluateTemplate(query, variables, timespan),
      timespan,
      value,
    };
  },
  {
    optionsLoaded: UIActions.monitoringDashboardsVariableOptionsLoaded,
    patchVariable: UIActions.monitoringDashboardsPatchVariable,
  },
)(SingleVariableDropdown_);

const AllVariableDropdowns_: React.FC<AllVariableDropdownsProps> = ({ variables }) => (
  <>
    {variables.keySeq().map((name) => (
      <SingleVariableDropdown key={name} id={name} name={name} />
    ))}
  </>
);
const AllVariableDropdowns = connect(({ UI }: RootState) => ({
  variables: UI.getIn(['monitoringDashboards', 'variables']),
}))(AllVariableDropdowns_);

const TimespanDropdown_: React.FC<TimespanDropdownProps> = ({ timespan }) => {
  const dispatch = useDispatch();
  const { t } = useTranslation();

  const onChange = React.useCallback(
    (v: string) => {
      dispatch(UIActions.monitoringDashboardsSetTimespan(parsePrometheusDuration(v)));
      dispatch(UIActions.monitoringDashboardsSetEndTime(null));
    },
    [dispatch],
  );

  const timespanOptions = {
    '5m': t('public~Last {{count}} minute', { count: 5 }),
    '15m': t('public~Last {{count}} minute', { count: 15 }),
    '30m': t('public~Last {{count}} minute', { count: 30 }),
    '1h': t('public~Last {{count}} hour', { count: 1 }),
    '2h': t('public~Last {{count}} hour', { count: 2 }),
    '6h': t('public~Last {{count}} hour', { count: 6 }),
    '12h': t('public~Last {{count}} hour', { count: 12 }),
    '1d': t('public~Last {{count}} day', { count: 1 }),
    '2d': t('public~Last {{count}} day', { count: 2 }),
    '1w': t('public~Last {{count}} week', { count: 1 }),
    '2w': t('public~Last {{count}} week', { count: 2 }),
  };

  return (
    <VariableDropdown
      id="monitoring-time-range-dropdown"
      items={timespanOptions}
      label={t('public~Time range')}
      onChange={onChange}
      selectedKey={formatPrometheusDuration(timespan)}
    />
  );
};

export const TimespanDropdown = connect(({ UI }: RootState) => ({
  timespan: UI.getIn(['monitoringDashboards', 'timespan']),
}))(TimespanDropdown_);

const PollIntervalDropdown_ = ({ interval, setInterval }) => {
  const { t } = useTranslation();

  return (
    <div className="form-group monitoring-dashboards__dropdown-wrap">
      <label htmlFor="refresh-interval-dropdown" className="monitoring-dashboards__dropdown-title">
        {t('public~Refresh interval')}
      </label>
      <IntervalDropdown
        interval={interval}
        setInterval={setInterval}
        id="refresh-interval-dropdown"
      />
    </div>
  );
};

export const PollIntervalDropdown = connect(
  ({ UI }: RootState) => ({
    interval: UI.getIn(['monitoringDashboards', 'pollInterval']),
  }),
  {
    setInterval: UIActions.monitoringDashboardsSetPollInterval,
  },
)(PollIntervalDropdown_);

const QueryBrowserLink = ({ queries }) => {
  const { t } = useTranslation();

  const params = new URLSearchParams();
  queries.forEach((q, i) => params.set(`query${i}`, q));

  return (
    <DashboardCardLink
      aria-label={t('public~Inspect')}
      to={`/monitoring/query-browser?${params.toString()}`}
    >
      {t('public~Inspect')}
    </DashboardCardLink>
  );
};

// Determine how many columns a panel should span. If panel specifies a `span`, use that. Otherwise
// look for a `breakpoint` percentage. If neither are specified, default to 12 (full width).
const getPanelSpan = (panel: Panel): number => {
  if (panel.span) {
    return panel.span;
  }
  const breakpoint = _.toInteger(_.trimEnd(panel.breakpoint, '%'));
  if (breakpoint > 0) {
    return Math.round(12 * (breakpoint / 100));
  }
  return 12;
};

const getPanelClassModifier = (panel: Panel): string => {
  const span: number = getPanelSpan(panel);
  switch (span) {
    case 6:
      return 'max-2';
    case 2:
    // fallthrough
    case 4:
    // fallthrough
    case 5:
      return 'max-3';
    case 3:
      return 'max-4';
    default:
      return 'max-1';
  }
};

// Matches Prometheus labels surrounded by {{ }} in the graph legend label templates
const legendTemplateOptions = { interpolate: /{{([a-zA-Z_][a-zA-Z0-9_]*)}}/g };

const Card_: React.FC<CardProps> = ({ panel, pollInterval, timespan, variables }) => {
  const formatLegendLabel = React.useCallback(
    (labels, i) => {
      const legendFormat = panel.targets?.[i]?.legendFormat;
      const compiled = _.template(legendFormat, legendTemplateOptions);
      try {
        return compiled(labels);
      } catch (e) {
        // If we can't format the label (e.g. if one of it's variables is missing from `labels`),
        // show the template string instead
        return legendFormat;
      }
    },
    [panel],
  );

  if (panel.type === 'row') {
    return (
      <>
        {_.map(panel.panels, (p) => (
          <Card key={p.id} panel={p} />
        ))}
      </>
    );
  }

  if (!['grafana-piechart-panel', 'graph', 'singlestat', 'table'].includes(panel.type)) {
    return null;
  }

  const variablesJS: VariablesMap = variables.toJS();

  const rawQueries = _.map(panel.targets, 'expr');
  if (!rawQueries.length) {
    return null;
  }
  const queries = rawQueries.map((expr) => evaluateTemplate(expr, variablesJS, timespan));
  const isLoading = _.some(queries, _.isUndefined);

  const panelClassModifier = getPanelClassModifier(panel);

  return (
    <div
      className={`monitoring-dashboards__panel monitoring-dashboards__panel--${panelClassModifier}`}
    >
      <DashboardCard
        className="monitoring-dashboards__card"
        gradient={panel.type === 'grafana-piechart-panel'}
      >
        <DashboardCardHeader className="monitoring-dashboards__card-header">
          <DashboardCardTitle>{panel.title}</DashboardCardTitle>
          {!isLoading && <QueryBrowserLink queries={queries} />}
        </DashboardCardHeader>
        <DashboardCardBody className="co-dashboard-card__body--dashboard-graph">
          {isLoading ? (
            <LoadingInline />
          ) : (
            <>
              {panel.type === 'grafana-piechart-panel' && (
                <BarChart pollInterval={pollInterval} query={queries[0]} />
              )}
              {panel.type === 'graph' && (
                <Graph
                  formatLegendLabel={panel.legend?.show ? formatLegendLabel : undefined}
                  isStack={panel.stack}
                  pollInterval={pollInterval}
                  queries={queries}
                />
              )}
              {panel.type === 'singlestat' && (
                <SingleStat panel={panel} pollInterval={pollInterval} query={queries[0]} />
              )}
              {panel.type === 'table' && (
                <Table panel={panel} pollInterval={pollInterval} queries={queries} />
              )}
            </>
          )}
        </DashboardCardBody>
      </DashboardCard>
    </div>
  );
};
const Card = connect(({ UI }: RootState) => ({
  pollInterval: UI.getIn(['monitoringDashboards', 'pollInterval']),
  timespan: UI.getIn(['monitoringDashboards', 'timespan']),
  variables: UI.getIn(['monitoringDashboards', 'variables']),
}))(Card_);

const PanelsRow: React.FC<{ row: Row }> = ({ row }) => {
  const showButton = row.showTitle && !_.isEmpty(row.title);

  const [isExpanded, toggleIsExpanded] = useBoolean(showButton ? !row.collapse : true);

  const Icon = isExpanded ? AngleDownIcon : AngleRightIcon;
  const title = isExpanded ? 'Hide' : 'Show';

  return (
    <div>
      {showButton && (
        <Button
          aria-label={title}
          className="pf-m-link--align-left"
          onClick={toggleIsExpanded}
          style={{ fontSize: 24 }}
          title={title}
          variant="plain"
        >
          <Icon />
          &nbsp;{row.title}
        </Button>
      )}
      {isExpanded && (
        <div className="monitoring-dashboards__row">
          {_.map(row.panels, (panel) => (
            <Card key={panel.id} panel={panel} />
          ))}
        </div>
      )}
    </div>
  );
};

const Board: React.FC<BoardProps> = ({ rows }) => (
  <>
    {_.map(rows, (row) => (
      <PanelsRow key={_.map(row.panels, 'id').join()} row={row} />
    ))}
  </>
);

const GrafanaLink = () =>
  _.isEmpty(window.SERVER_FLAGS.grafanaPublicURL) ? null : (
    <span className="monitoring-header-link">
      <ExternalLink href={window.SERVER_FLAGS.grafanaPublicURL} text="Grafana UI" />
    </span>
  );

const MonitoringDashboardsPage_: React.FC<MonitoringDashboardsPageProps> = ({
  deleteAll,
  match,
  patchAllVariables,
}) => {
  const dispatch = useDispatch();
  const { t } = useTranslation();

  const [board, setBoard] = React.useState<string>();
  const [boards, setBoards] = React.useState<Board[]>([]);
  const [error, setError] = React.useState<string>();
  const [isLoading, , , setLoaded] = useBoolean(true);

  const safeFetch = React.useCallback(useSafeFetch(), []);

  // Clear queries on unmount
  React.useEffect(() => deleteAll, [deleteAll]);

  React.useEffect(() => {
    safeFetch('/api/console/monitoring-dashboard-config')
      .then((response) => {
        setLoaded();
        setError(undefined);

        const getBoardData = (item): Board => {
          try {
            return {
              data: JSON.parse(_.values(item.data)[0]),
              name: item.metadata.name,
            };
          } catch (e) {
            setError(
              t('public~Could not parse JSON data for dashboard "{{dashboard}}"', {
                dashboard: item.metadata.name,
              }),
            );
          }
        };

        const newBoards = _.sortBy(_.map(response.items, getBoardData), (v) =>
          _.toLower(v?.data?.title),
        );
        setBoards(newBoards);
      })
      .catch((err) => {
        setLoaded();
        if (err.name !== 'AbortError') {
          setError(_.get(err, 'json.error', err.message));
        }
      });
  }, [safeFetch, setLoaded, t]);

  const boardItems = React.useMemo(() => _.mapValues(_.mapKeys(boards, 'name'), 'data.title'), [
    boards,
  ]);

  const changeBoard = React.useCallback(
    (newBoard: string) => {
      if (newBoard !== board) {
        const data = _.find(boards, { name: newBoard })?.data;

        const allVariables = {};
        _.each(data?.templating?.list, (v) => {
          if (v.type === 'query' || v.type === 'interval') {
            allVariables[v.name] = ImmutableMap({
              isHidden: v.hide !== 0,
              isLoading: v.type === 'query',
              options: _.map(v.options, 'value'),
              query: v.type === 'query' ? v.query : undefined,
              value: _.find(v.options, { selected: true })?.value || v.options?.[0]?.value,
            });
          }
        });
        patchAllVariables(allVariables);

        // Set time range options to their defaults since they may have been changed on the
        // previous dashboard
        dispatch(UIActions.monitoringDashboardsSetEndTime(null));
        dispatch(UIActions.monitoringDashboardsSetTimespan(MONITORING_DASHBOARDS_DEFAULT_TIMESPAN));

        setBoard(newBoard);
        history.replace(`/monitoring/dashboards/${newBoard}`);
      }
    },
    [board, boards, dispatch, patchAllVariables],
  );

  // Default to displaying the first board
  React.useEffect(() => {
    if (!board && !_.isEmpty(boards)) {
      changeBoard(match.params.board || boards?.[0]?.name);
    }
  }, [board, boards, changeBoard, match.params.board]);

  if (error) {
    return <ErrorAlert message={error} />;
  }

  const data = _.find(boards, { name: board })?.data;

  // If we don't find any rows, build the rows array based on what we have in `data.panels`
  const rows = data?.rows?.length
    ? data.rows
    : data?.panels?.reduce((acc, panel) => {
        if (panel.type === 'row' || acc.length === 0) {
          acc.push(panel);
        } else {
          const row = acc[acc.length - 1];
          if (_.isNil(row.panels)) {
            row.panels = [];
          }
          row.panels.push(panel);
        }
        return acc;
      }, []);

  return (
    <>
      <Helmet>
        <title>{t('public~Metrics dashboards')}</title>
      </Helmet>
      <div className="co-m-nav-title co-m-nav-title--detail">
        <div className="monitoring-dashboards__header">
          <h1 className="co-m-pane__heading">
            <span>
              {t('public~Dashboards')} <GrafanaLink />
            </span>
          </h1>
          <div className="monitoring-dashboards__options">
            <TimespanDropdown />
            <PollIntervalDropdown />
          </div>
        </div>
        <div className="monitoring-dashboards__variables">
          {!_.isEmpty(boardItems) && (
            <VariableDropdown
              id="monitoring-board-dropdown"
              items={boardItems}
              label={t('public~Dashboard')}
              onChange={changeBoard}
              selectedKey={board}
            />
          )}
          <AllVariableDropdowns key={board} />
        </div>
      </div>
      <Dashboard>{isLoading ? <LoadingInline /> : <Board key={board} rows={rows} />}</Dashboard>
    </>
  );
};
const MonitoringDashboardsPage = connect(null, {
  deleteAll: UIActions.queryBrowserDeleteAllQueries,
  patchAllVariables: UIActions.monitoringDashboardsPatchAllVariables,
})(MonitoringDashboardsPage_);

type TemplateVariable = {
  hide: number;
  name: string;
  options: { selected: boolean; value: string }[];
  query: string;
  type: string;
};

type Row = {
  collapse?: boolean;
  panels: Panel[];
  showTitle?: boolean;
  title?: string;
};

type Board = {
  data: {
    panels: Panel[];
    rows: Row[];
    templating: {
      list: TemplateVariable[];
    };
    title: string;
  };
  name: string;
};

type Variable = {
  isHidden?: boolean;
  isLoading?: boolean;
  options?: string[];
  query?: string;
  value?: string;
};

type VariablesMap = { [key: string]: Variable };

type VariableDropdownProps = {
  id: string;
  isError?: boolean;
  items: { [key: string]: string };
  label: string;
  onChange: (v: string) => void;
  selectedKey: string;
};

type SingleVariableDropdownProps = {
  id: string;
  isHidden: boolean;
  name: string;
  options?: string[];
  patchVariable: (key: string, patch: Variable) => undefined;
  query?: string;
  optionsLoaded: (key: string, newOptions: string[]) => undefined;
  timespan: number;
  value?: string;
};

type BoardProps = {
  rows: Row[];
};

type AllVariableDropdownsProps = {
  variables: ImmutableMap<string, ImmutableMap<string, any>>;
};

type TimespanDropdownProps = {
  timespan: number;
};

type CardProps = {
  panel: Panel;
  pollInterval: null | number;
  timespan: number;
  variables: ImmutableMap<string, ImmutableMap<string, any>>;
};

type MonitoringDashboardsPageProps = {
  deleteAll: () => undefined;
  match: {
    params: { board: string };
  };
  patchAllVariables: (variables: VariablesMap) => undefined;
};

export default withFallback(MonitoringDashboardsPage, ErrorBoundaryFallback);
