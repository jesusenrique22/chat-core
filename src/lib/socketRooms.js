/** Sala compartida: todos los agentes del dashboard se unen al conectar. */
const AGENTS_DASHBOARD_ROOM = 'agents-dashboard';

const getDepartmentRoom = (departmentId) => `dept-${departmentId}`;

module.exports = { AGENTS_DASHBOARD_ROOM, getDepartmentRoom };

