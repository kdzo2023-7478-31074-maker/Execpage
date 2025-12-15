
import React, { useEffect, useState } from 'react';
import { supabase } from '../supabaseClient';
import { SpinnerIcon, ChartIcon } from './icons';
import AnimatedWrapper from './AnimatedWrapper';
import { 
    BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
    AreaChart, Area, PieChart, Pie, Cell, Legend
} from 'recharts';

interface ChartContainerProps {
    title: string;
    children: React.ReactNode;
}

const ChartContainer: React.FC<ChartContainerProps> = ({ title, children }) => (
    <div className="bg-[#111827]/50 border border-cyan-500/20 rounded-xl p-6 shadow-lg backdrop-blur-sm flex flex-col h-[450px]">
        <h3 className="text-lg font-semibold text-white mb-4 border-b border-gray-700 pb-2">{title}</h3>
        <div className="flex-1 w-full min-h-0">
            {children}
        </div>
    </div>
);

const PIE_COLORS = ['#22d3ee', '#3b82f6', '#a855f7', '#f43f5e', '#10b981'];

const AnalyticsPage: React.FC = () => {
    const [loading, setLoading] = useState(true);
    
    // Data States
    const [visitTrends, setVisitTrends] = useState<any[]>([]);
    const [apptByDoctor, setApptByDoctor] = useState<any[]>([]);
    const [deptMatrix, setDeptMatrix] = useState<any[]>([]);
    const [topMeds, setTopMeds] = useState<any[]>([]);

    useEffect(() => {
        const fetchData = async () => {
            setLoading(true);
            try {
                const now = new Date();
                const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

                // Fetch necessary tables
                // Filter billing to current month for the Revenue Matrix
                const { data: billingData } = await supabase
                    .from('billing_and_insurance')
                    .select('*')
                    .gte('admission_date', startOfMonth.toISOString());

                // Fetch ALL appointments for historical trends, filter in memory for matrix
                const { data: apptData } = await supabase.from('appointments').select('*, employees(full_name, salary, department_name)');
                const { data: employeesData } = await supabase.from('employees').select('employee_id, full_name, salary, department_name');
                
                // Fetch prescriptions for current month (Pie Chart)
                const { data: rxData } = await supabase
                    .from('prescriptions')
                    .select('prescription_date, medication_id')
                    .gte('prescription_date', startOfMonth.toISOString());
                
                // Fetch medications (get generic_name for ID lookup)
                const { data: medData } = await supabase
                    .from('medications')
                    .select('medication_id, generic_name');

                // --- Visit Frequency Trends (Appointments Over Time - All History) ---
                if (apptData) {
                    const monthlyVisits: Record<string, { count: number; date: number }> = {};
                    
                    apptData.forEach((appt: any) => {
                        const date = new Date(appt.appt_datetime);
                        if(isNaN(date.getTime())) return;
                        
                        // Group by Month
                        const monthStart = new Date(date.getFullYear(), date.getMonth(), 1);
                        const key = monthStart.toLocaleDateString('default', { month: 'short', year: 'numeric' });
                        const sortKey = monthStart.getTime();

                        if (!monthlyVisits[key]) monthlyVisits[key] = { count: 0, date: sortKey };
                        monthlyVisits[key].count += 1;
                    });

                    const sortedVisits = Object.entries(monthlyVisits)
                        .sort(([, a], [, b]) => a.date - b.date)
                        .map(([name, val]) => ({ name, count: val.count }));
                    
                    setVisitTrends(sortedVisits);
                }

                // --- Top Doctors (Employees & Appointments) ---
                if (apptData) {
                    const doctorMap: Record<string, number> = {};

                    apptData.forEach((appt: any) => {
                        const empName = appt.employees?.full_name || `ID: ${appt.employee_id}`;
                        doctorMap[empName] = (doctorMap[empName] || 0) + 1;
                    });

                    setApptByDoctor(
                        Object.keys(doctorMap).map(key => ({ name: key, count: doctorMap[key] }))
                        .sort((a, b) => b.count - a.count).slice(0, 10)
                    );
                }

                // --- Top Medications (Pie Chart) ---
                if (rxData && medData) {
                    const medLookup = new Map<number, string>();
                    medData.forEach((m: any) => {
                        medLookup.set(m.medication_id, m.generic_name);
                    });

                    const medMap: Record<string, number> = {};
                    rxData.forEach((rx: any) => {
                        const medName = medLookup.get(rx.medication_id) || `Unknown Med (ID: ${rx.medication_id})`;
                        medMap[medName] = (medMap[medName] || 0) + 1;
                    });

                    const sortedMeds = Object.entries(medMap)
                        .map(([name, value]) => ({ name, value }))
                        .sort((a, b) => b.value - a.value)
                        .slice(0, 5); // Top 5
                    
                    setTopMeds(sortedMeds);
                }

                // --- Department Matrix (Employees -> Appts -> Billing) ---
                // CALCULATED FOR CURRENT MONTH ONLY
                if (employeesData && apptData && billingData) {
                    // Filter appointments to current month
                    const monthlyAppts = apptData.filter((a: any) => new Date(a.appt_datetime) >= startOfMonth);

                    const depts: Record<string, { staff: number, appts: number, patients: Set<number>, revenue: number }> = {};
                    
                    // Helper to normalize strings (remove whitespace)
                    const normalize = (str: string | null) => str ? str.trim() : 'Unassigned';

                    // 1. Group Staff (Total Active Staff)
                    employeesData.forEach((e: any) => {
                         const dName = normalize(e.department_name);
                         if(!depts[dName]) depts[dName] = { staff: 0, appts: 0, patients: new Set(), revenue: 0 };
                         depts[dName].staff++;
                    });

                    // 2. Map Appts to Dept
                    const empDeptMap: Record<number, string> = {};
                    employeesData.forEach((e: any) => empDeptMap[e.employee_id] = normalize(e.department_name));

                    // Map Patient Spend (Current Month Only)
                    const patientSpend: Record<number, number> = {};
                    billingData.forEach((b: any) => patientSpend[b.patient_id] = (patientSpend[b.patient_id] || 0) + b.total_charges);

                    // Count visits per patient THIS MONTH to split revenue accurately
                    const patientVisitCounts: Record<number, number> = {};
                    monthlyAppts.forEach((a: any) => {
                        if (a.patient_id) patientVisitCounts[a.patient_id] = (patientVisitCounts[a.patient_id] || 0) + 1;
                    });

                    // Aggregate using Monthly Appointments
                    monthlyAppts.forEach((a: any) => {
                        const dept = empDeptMap[a.employee_id];
                        if (dept && depts[dept]) {
                            depts[dept].appts++;
                            if (a.patient_id) {
                                depts[dept].patients.add(a.patient_id);
                                
                                // Attribute revenue: Total Monthly Bill / Number of Visits this Month
                                const revenue = patientSpend[a.patient_id] || 0;
                                const visits = patientVisitCounts[a.patient_id] || 1;
                                depts[dept].revenue += revenue / visits;
                            }
                        }
                    });

                    const matrix = Object.entries(depts).map(([name, data]) => ({
                        department: name,
                        staff: data.staff,
                        appts: data.appts,
                        unique_patients: data.patients.size,
                        revenue: Math.round(data.revenue),
                        efficiency: data.staff > 0 ? Math.round(data.revenue / data.staff) : 0
                    })).sort((a,b) => b.revenue - a.revenue);

                    setDeptMatrix(matrix);
                }

            } catch (error) {
                console.error("Error fetching analytics:", error);
            } finally {
                setLoading(false);
            }
        };

        fetchData();
    }, []);

    if (loading) {
        return (
            <div className="flex flex-col items-center justify-center h-full text-cyan-400">
                <SpinnerIcon className="h-12 w-12 animate-spin mb-4" />
                <p className="text-gray-300">Aggregating live database metrics...</p>
            </div>
        );
    }

    return (
        <AnimatedWrapper delay={0}>
            <div className="max-w-7xl mx-auto space-y-8 pb-10">
                <div className="p-8 bg-[#111827]/50 backdrop-blur-sm border border-cyan-500/20 rounded-xl shadow-2xl shadow-cyan-500/10">
                    <div className="flex items-center gap-6 mb-2">
                        <ChartIcon className="h-16 w-16 text-cyan-400" />
                        <div>
                            <h1 className="text-3xl md:text-4xl font-bold text-white tracking-wider">Analytics & Relationships</h1>
                            <p className="mt-2 text-md text-[#A9B4C2]">
                                Real-time operational intelligence derived from live database records.
                            </p>
                        </div>
                    </div>
                </div>

                {/* --- DEPARTMENT PERFORMANCE MATRIX --- */}
                <div className="bg-[#111827]/50 border border-cyan-500/20 rounded-xl p-6 shadow-lg backdrop-blur-sm">
                    <div className="flex justify-between items-center mb-6 border-b border-gray-700 pb-4">
                        <h3 className="text-xl font-semibold text-white">Department Performance Matrix (This Month)</h3>
                    </div>
                    
                    <div className="overflow-x-auto">
                        <table className="w-full text-left border-collapse">
                            <thead>
                                <tr className="text-cyan-400 text-sm border-b border-gray-700">
                                    <th className="py-3 px-4 font-bold uppercase tracking-wider">Department</th>
                                    <th className="py-3 px-4 font-bold uppercase tracking-wider text-right">Staff Count</th>
                                    <th className="py-3 px-4 font-bold uppercase tracking-wider text-right">Appt. Volume</th>
                                    <th className="py-3 px-4 font-bold uppercase tracking-wider text-right">Unique Patients</th>
                                    <th className="py-3 px-4 font-bold uppercase tracking-wider text-right">Est. Revenue ($)</th>
                                    <th className="py-3 px-4 font-bold uppercase tracking-wider text-right">Rev / Staff ($)</th>
                                </tr>
                            </thead>
                            <tbody className="text-gray-300 text-sm">
                                {deptMatrix.map((dept, idx) => (
                                    <tr key={idx} className="border-b border-gray-800 hover:bg-cyan-950/20 transition-colors">
                                        <td className="py-3 px-4 font-medium text-white">{dept.department}</td>
                                        <td className="py-3 px-4 text-right">{dept.staff}</td>
                                        <td className="py-3 px-4 text-right">{dept.appts}</td>
                                        <td className="py-3 px-4 text-right">{dept.unique_patients}</td>
                                        <td className="py-3 px-4 text-right text-green-400 font-mono">{dept.revenue.toLocaleString()}</td>
                                        <td className="py-3 px-4 text-right font-mono">
                                            <span className={`px-2 py-1 rounded ${dept.efficiency > 50000 ? 'bg-green-900/40 text-green-300' : 'bg-gray-800'}`}>
                                                {dept.efficiency.toLocaleString()}
                                            </span>
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                </div>

                {/* --- VISIT FREQUENCY --- */}
                <ChartContainer title="Patient Visit Frequency (Monthly)">
                    <ResponsiveContainer width="100%" height="100%">
                        <AreaChart data={visitTrends} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                            <defs>
                                <linearGradient id="visitColor" x1="0" y1="0" x2="0" y2="1">
                                    <stop offset="5%" stopColor="#22d3ee" stopOpacity={0.8}/>
                                    <stop offset="95%" stopColor="#22d3ee" stopOpacity={0}/>
                                </linearGradient>
                            </defs>
                            <XAxis dataKey="name" stroke="#9CA3AF" />
                            <YAxis stroke="#9CA3AF" />
                            <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                            <Tooltip contentStyle={{ backgroundColor: '#1F2937', borderColor: '#374151', color: '#fff' }} />
                            <Area type="monotone" dataKey="count" stroke="#22d3ee" fillOpacity={1} fill="url(#visitColor)" name="Visits" />
                        </AreaChart>
                    </ResponsiveContainer>
                </ChartContainer>

                {/* --- TOP DOCTORS & MEDICATIONS ROW --- */}
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                    {/* --- TOP DOCTORS --- */}
                    <ChartContainer title="Top 10 Providers by Volume">
                        <ResponsiveContainer width="100%" height="100%">
                            <BarChart layout="vertical" data={apptByDoctor} margin={{ top: 5, right: 30, left: 40, bottom: 5 }}>
                                <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                                <XAxis type="number" stroke="#9CA3AF" />
                                <YAxis dataKey="name" type="category" width={120} stroke="#9CA3AF" tick={{fontSize: 11}} />
                                <Tooltip contentStyle={{ backgroundColor: '#1F2937', borderColor: '#374151', color: '#fff' }} />
                                <Bar dataKey="count" fill="#3b82f6" name="Appointments" />
                            </BarChart>
                        </ResponsiveContainer>
                    </ChartContainer>

                    {/* --- TOP MEDICATIONS --- */}
                    <ChartContainer title="Top Prescribed Meds (This Month)">
                        {topMeds.length > 0 ? (
                            <ResponsiveContainer width="100%" height="100%">
                                <PieChart>
                                    <Pie
                                        data={topMeds}
                                        cx="50%"
                                        cy="50%"
                                        labelLine={true}
                                        label={({ name, value, percent }) => `${name}: ${value} (${(percent * 100).toFixed(0)}%)`}
                                        outerRadius={100}
                                        fill="#8884d8"
                                        dataKey="value"
                                    >
                                        {topMeds.map((entry, index) => (
                                            <Cell key={`cell-${index}`} fill={PIE_COLORS[index % PIE_COLORS.length]} />
                                        ))}
                                    </Pie>
                                    <Tooltip contentStyle={{ backgroundColor: '#1F2937', borderColor: '#374151', color: '#fff' }} />
                                    <Legend 
                                        verticalAlign="bottom" 
                                        height={36}
                                        wrapperStyle={{ paddingTop: '20px' }}
                                    />
                                </PieChart>
                            </ResponsiveContainer>
                        ) : (
                            <div className="flex h-full items-center justify-center text-gray-500 italic">
                                No prescription data available for this month.
                            </div>
                        )}
                    </ChartContainer>
                </div>
            </div>
        </AnimatedWrapper>
    );
};

export default AnalyticsPage;
