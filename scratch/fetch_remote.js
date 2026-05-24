const https = require('https');

const apiKey = "ca_7d94a7d627324b79870c77e3307190ce";

function makeRequest(url) {
  return new Promise((resolve, reject) => {
    const headers = {
      'x-api-key': apiKey,
      'Content-Type': 'application/json'
    };
    https.get(url, { headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, raw: data });
        }
      });
    }).on('error', reject);
  });
}

async function run() {
  console.log("Fetching projects from VPS...");
  const projectsRes = await makeRequest('https://atlas.genrostore.com/api/projects');
  console.log("Projects status:", projectsRes.status);
  console.log("Projects:", JSON.stringify(projectsRes.data, null, 2));

  if (Array.isArray(projectsRes.data)) {
    for (const p of projectsRes.data) {
      if (p.name.includes('auto-edit-video-reup')) {
        console.log(`\nFetching analysis for ${p.name} (${p.dir})...`);
        const analysisRes = await makeRequest(`https://atlas.genrostore.com/api/analysis?projectDir=${encodeURIComponent(p.dir)}`);
        console.log("Analysis status:", analysisRes.status);
        if (analysisRes.data) {
          const base = analysisRes.data.analysis || analysisRes.data;
          const stats = base.stats || {};
          const entityCounts = base.entityCounts || {};
          console.log("Stats:", stats);
          console.log("EntityCounts:", entityCounts);
          console.log("Total Nodes in graph:", base.graph ? base.graph.nodes.length : 'none');
          if (base.graph && base.graph.nodes) {
            const modules = base.graph.nodes.filter(n => n.type === 'module').map(n => n.name);
            console.log(`Modules (${modules.length}):`, modules);
          }
        } else {
          console.log("No data returned:", analysisRes.raw);
        }
      }
    }
  }
}

run().catch(console.error);
