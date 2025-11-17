# CD into the directory of this script
cd "$(dirname "$0")" || exit 1



echo 'y' | npx npm-check-updates -u
npm install
