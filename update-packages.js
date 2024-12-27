
const { exec } = require('child_process');

console.log('Checking for package updates...');

exec('npm update', (error, stdout, stderr) => {
  if (error) {
    console.error(`Error updating packages: ${error.message}`);
    return;
  }
  if (stderr) {
    console.error(`Error output: ${stderr}`);
    return;
  }
  console.log(`Update output: ${stdout}`);
  console.log('Packages updated successfully.');
  // Start the main application
  require('./index.js');
});