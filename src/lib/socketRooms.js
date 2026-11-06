const { normalizeCustomerId } = require('./validate');

/** Sala compartida: todos los agentes del dashboard se unen al conectar. */
const AGENTS_DASHBOARD_ROOM = 'agents-dashboard';

const getDepartmentRoom = (departmentId) => `dept-${departmentId}`;

/** Sala de un ciudadano: todos sus sockets, sin importar la conversación que tengan abierta. */
const getCitizenRoom = (customerId) => `citizen-${normalizeCustomerId(customerId)}`;

module.exports = { AGENTS_DASHBOARD_ROOM, getDepartmentRoom, getCitizenRoom };
