import BaseTable from './BaseTable.jsx';
import CallToAction from './CallToAction.jsx';
import Card from '@material-ui/core/Card';
import CardContent from '@material-ui/core/CardContent';
import ErrorBanner from './ErrorBanner.jsx';
import Grid from '@material-ui/core/Grid';
import MeshedStatusTable from './MeshedStatusTable.jsx';
import Percentage from './util/Percentage.js';
import PropTypes from 'prop-types';
import React from 'react';
import Spinner from './util/Spinner.jsx';
import StatusTable from './StatusTable.jsx';
import Typography from '@material-ui/core/Typography';
import _ from 'lodash';
import { incompleteMeshMessage } from './util/CopyUtils.jsx';
import moment from 'moment';
import { withContext } from './util/AppContext.jsx';

const serviceMeshDetailsColumns = [
  {
    title: "Name",
    dataIndex: "name"
  },
  {
    title: "Value",
    dataIndex: "value",
    isNumeric: true
  }
];

const getPodClassification = pod => {
  if (pod.status === "Running") {
    return "good";
  } else if (pod.status === "Waiting") {
    return "default";
  } else {
    return "poor";
  }
};

const componentsToDeployNames = {
  "Grafana" : "linkerd-grafana",
  "Prometheus": "linkerd-prometheus",
  "Proxy API": "linkerd-controller",
  "Public API": "linkerd-controller",
  "Tap": "linkerd-controller",
  "Web UI": "linkerd-web"
};

class ServiceMesh extends React.Component {
  static defaultProps = {
    productName: 'controller'
  }

  static propTypes = {
    api: PropTypes.shape({
      cancelCurrentRequests: PropTypes.func.isRequired,
      PrefixedLink: PropTypes.func.isRequired,
      fetchMetrics: PropTypes.func.isRequired,
      getCurrentPromises: PropTypes.func.isRequired,
      setCurrentRequests: PropTypes.func.isRequired,
      urlsForResource: PropTypes.func.isRequired,
    }).isRequired,
    controllerNamespace: PropTypes.string.isRequired,
    productName: PropTypes.string,
    releaseVersion: PropTypes.string.isRequired,
  }

  constructor(props) {
    super(props);
    this.loadFromServer = this.loadFromServer.bind(this);
    this.handleApiError = this.handleApiError.bind(this);
    this.api = this.props.api;

    this.state = {
      pollingInterval: 2000,
      components: [],
      pendingRequests: false,
      loaded: false,
      error: null
    };
  }

  componentDidMount() {
    this.loadFromServer();
    this.timerId = window.setInterval(this.loadFromServer, this.state.pollingInterval);
  }

  componentWillUnmount() {
    window.clearInterval(this.timerId);
    this.api.cancelCurrentRequests();
  }

  getServiceMeshDetails() {
    return [
      { key: 1, name: this.props.productName + " version", value: this.props.releaseVersion },
      { key: 2, name: this.props.productName + " namespace", value: this.props.controllerNamespace },
      { key: 3, name: "Control plane components", value: this.componentCount() },
      { key: 4, name: "Data plane proxies", value: this.proxyCount() }
    ];
  }

  getControllerComponentData(podData) {
    let podDataByDeploy = _.chain(podData.pods)
      .filter( "controlPlane")
      .groupBy("deployment")
      .mapKeys((pods, dep) => {
        return dep.split("/")[1];
      })
      .value();

    return _.map(componentsToDeployNames, (deployName, component) => {
      return {
        name: component,
        pods: _.map(podDataByDeploy[deployName], p => {
          let uptimeSec = !p.uptime ? 0 : p.uptime.split(".")[0];
          let uptime = moment.duration(parseInt(uptimeSec, 10) * 1000);

          return {
            name: p.name,
            value: getPodClassification(p),
            uptime: uptime.humanize(),
            uptimeSec
          };
        })
      };
    });
  }

  extractNsStatuses(nsData) {
    let podsByNs = _.get(nsData, ["ok", "statTables", 0, "podGroup", "rows"], []);
    let dataPlaneNamepaces = _.map(podsByNs, ns => {
      let meshedPods = parseInt(ns.meshedPodCount, 10);
      let totalPods = parseInt(ns.runningPodCount, 10);
      let failedPods = parseInt(ns.failedPodCount, 10);

      return {
        namespace: ns.resource.name,
        meshedPodsStr: ns.meshedPodCount + "/" + ns.runningPodCount,
        meshedPercent: new Percentage(meshedPods, totalPods),
        meshedPods,
        totalPods,
        failedPods,
        errors: ns.errorsByPod
      };
    });
    return _.compact(dataPlaneNamepaces);
  }

  loadFromServer() {
    if (this.state.pendingRequests) {
      return; // don't make more requests if the ones we sent haven't completed
    }
    this.setState({ pendingRequests: true });

    this.api.setCurrentRequests([
      this.api.fetchPods(this.props.controllerNamespace),
      this.api.fetchMetrics(this.api.urlsForResource("namespace"))
    ]);

    this.serverPromise = Promise.all(this.api.getCurrentPromises())
      .then(([pods, nsStats]) => {
        this.setState({
          components: this.getControllerComponentData(pods),
          nsStatuses: this.extractNsStatuses(nsStats),
          pendingRequests: false,
          loaded: true,
          error: null
        });
      })
      .catch(this.handleApiError);
  }

  handleApiError(e) {
    if (e.isCanceled) {
      return;
    }

    this.setState({
      pendingRequests: false,
      loaded: true,
      error: e
    });
  }

  componentCount() {
    return _.size(this.state.components);
  }

  proxyCount() {
    return _.sumBy(this.state.nsStatuses, d => {
      return d.namespace === this.props.controllerNamespace ? 0 : d.meshedPods;
    });
  }

  renderControlPlaneDetails() {
    return (
      <React.Fragment>
        <Grid container justify="space-between">
          <Grid item xs={3}>
            <Typography variant="h6">Control plane</Typography>
          </Grid>
          <Grid item xs={3}>
            <Typography align="right">Components</Typography>
            <Typography align="right">{this.componentCount()}</Typography>
          </Grid>
        </Grid>

        <StatusTable
          data={this.state.components}
          statusColumnTitle="Pod Status"
          shouldLink={false}
          api={this.api} />
      </React.Fragment>
    );
  }

  renderServiceMeshDetails() {
    return (
      <React.Fragment>
        <Typography variant="h6">Service mesh details</Typography>

        <BaseTable
          tableClassName="metric-table"
          tableRows={this.getServiceMeshDetails()}
          tableColumns={serviceMeshDetailsColumns}
          rowKey={d => d.key} />

      </React.Fragment>
    );
  }

  renderAddResourcesMessage() {
    let message = "";
    let numUnadded = 0;

    if (_.isEmpty(this.state.nsStatuses)) {
      message = "No resources detected.";
    } else {
      let meshedCount = _.countBy(this.state.nsStatuses, pod => {
        return pod.meshedPercent.get() > 0;
      });
      numUnadded = meshedCount["false"] || 0;
      message = numUnadded === 0 ? `All namespaces have a ${this.props.productName} install.` :
        `${numUnadded} ${numUnadded === 1 ? "namespace has" : "namespaces have"} no meshed resources.`;
    }

    return (
      <Card>
        <CardContent>
          <Typography>{message}</Typography>
          { numUnadded > 0 ? incompleteMeshMessage() : null }
        </CardContent>
      </Card>
    );
  }

  render() {
    return (
      <div className="page-content">
        { !this.state.error ? null : <ErrorBanner message={this.state.error} /> }
        { !this.state.loaded ? <Spinner /> : (
          <div>
            {this.proxyCount() === 0 ?
              <CallToAction
                numResources={_.size(this.state.nsStatuses)}
                resource="namespace" /> : null}

            <Grid container spacing={24}>
              <Grid item xs={8} container direction="column" >
                <Grid item>{this.renderControlPlaneDetails()}</Grid>
                <Grid item><MeshedStatusTable tableRows={_.sortBy(this.state.nsStatuses, "namespace")} /></Grid>
              </Grid>

              <Grid item xs={4} container direction="column" spacing={24}>
                <Grid item>{this.renderServiceMeshDetails()}</Grid>
                <Grid item>{this.renderAddResourcesMessage()}</Grid>
              </Grid>
            </Grid>
          </div>
        )}
      </div>
    );
  }
}

export default withContext(ServiceMesh);
